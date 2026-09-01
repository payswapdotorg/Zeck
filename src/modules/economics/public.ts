/**
 * Public contract barrel of the `economics` module.
 *
 * This file is the ONLY supported import surface for other modules and for
 * the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public module
 * rule"). Everything else under `src/modules/economics/` is private to this
 * module.
 *
 * WORK-032 introduces the governed ECONOMIC-ACTION boundary (ECO-001..008;
 * ADR-0018; `spec/architecture.md` §6): the provider-neutral
 * EconomicAction/payment-intent contract, bounded deterministic payment
 * authorization, machine-payment (HTTP 402) interoperability, settlement
 * correlation and delivery evidence, the payment-rail adapter CONTRACT
 * (implementations live under `src/integrations/payment-rails/`), and the
 * learning evidence projection.
 *
 * Authority map (everything is consumed, nothing is duplicated):
 *   policy → the policies module's authority through the REQUIRED
 *   admission port (no default-allow exists); capabilities → the
 *   capabilities registry through its REQUIRED port; budget → the budgets
 *   module's `BudgetAuthority` (reserve/settle/release — the ONE
 *   spending-control authority, no second ledger); executions → the
 *   canonical ledger's `recordStepEvent` seam (economic evidence rides
 *   the executions ledger); verification → the verification module
 *   consumes the delivery-evidence bundle through its own economic-delivery
 *   seam (delivery is decided THERE, never here).
 */

import type { ModuleDescriptor } from "../../shared/module";

export const moduleDescriptor: ModuleDescriptor = { id: "economics" };

export {
  createCapabilityEconomicAdmission,
  createPolicyEconomicAdmission,
  createSqlEconomicsModule,
  InMemoryEconomicStore,
  InMemoryEconomicsIdempotency,
  SqlEconomicStore,
  SqlEconomicsIdempotency,
} from "./adapters";
export { createEconomicActionService } from "./application/economic-action-service";
// Application: the governed economic-action boundary service.
export type {
  AuthorizeEconomicActionCommand,
  AuthorizeEconomicActionOutcome,
  ChargeEconomicActionCommand,
  ChargeEconomicActionOutcome,
  CreateEconomicActionCommand,
  CreateEconomicActionOutcome,
  EconomicActionService,
  EconomicActionServiceDeps,
  EconomicCommandScope,
  EconomicDeliveryEvidenceBundle,
  EconomicExecutionLedger,
  RecordDeliveryObservationCommand,
  RecordDeliveryOutcome,
  RecordExternalSettlementCommand,
  RecordExternalSettlementOutcome,
} from "./application/economic-action-service.contracts";

// Domain: the provider-neutral contracts (intent, authorization,
// machine-payment, settlement/delivery evidence, rail port, learning facts).
export type {
  AuthorizationUse,
  AuthorizationUseDenialCode,
  AuthorizationUseEvaluation,
  DeliveryObservationKind,
  DeliveryObservationRecord,
  EconomicActionDraft,
  EconomicActionEvent,
  EconomicActionRecord,
  EconomicActionStatus,
  EconomicActionValidationIssue,
  EconomicAmount,
  EconomicCapabilityKind,
  EconomicCapabilityRequirement,
  EconomicCurrency,
  EconomicDeliveryEvidence,
  EconomicEventType,
  EconomicOutcomeFact,
  EconomicOutcomeFactOutcome,
  EconomicPurpose,
  MicroUsdString,
  PaymentAuthorizationConstraints,
  PaymentAuthorizationRecord,
  PaymentAuthorizationReusePolicy,
  PaymentAuthorizationStatus,
  PaymentRail,
  PaymentRequiredParseCode,
  PaymentRequiredParseResult,
  PaymentRequiredSignal,
  PaymentRequiredTerms,
  RailConstraintCapabilities,
  RailPaymentRequest,
  RailSettlementObservation,
  RailSettlementStatus,
  RecipientKind,
  RecipientReference,
  SettlementObservationRecord,
  SettlementObservationStatus,
} from "./domain";
export {
  amountWithinBounds,
  compareEconomicMicroUsd,
  constraintsOfAction,
  DELIVERY_OBSERVATION_KINDS,
  ECONOMIC_ACTION_STATUSES,
  ECONOMIC_ACTION_TERMINAL_STATUSES,
  ECONOMIC_ACTION_TRANSITIONS,
  ECONOMIC_CAPABILITY_KINDS,
  ECONOMIC_CURRENCIES,
  ECONOMIC_EVENT_TYPES,
  ECONOMIC_OUTCOME_FACT_SCHEMA_VERSION,
  ECONOMIC_PURPOSES,
  economicActionCanTransition,
  economicActionDraftFromSignal,
  economicActionFingerprintParts,
  economicOutcomeFacts,
  evaluateAuthorizationUse,
  HTTP_PAYMENT_REQUIRED,
  isDeliveryObservationKind,
  isEconomicActionStatus,
  isEconomicCapabilityKind,
  isEconomicCurrency,
  isEconomicEventType,
  isEconomicMicroUsd,
  isEconomicPurpose,
  isRecipientKind,
  MAX_ECONOMIC_MICRO_USD,
  PAYMENT_AUTHORIZATION_REUSE_POLICIES,
  PAYMENT_AUTHORIZATION_STATUSES,
  PAYMENT_REQUIRED_SIGNAL_SCHEMA_VERSION,
  parseEconomicMicroUsd,
  parsePaymentRequiredSignal,
  RAIL_SETTLEMENT_STATUSES,
  RECIPIENT_KINDS,
  REQUIRED_RAIL_CAPABILITY_KEYS,
  railCanExpressConstraints,
  SETTLEMENT_OBSERVATION_STATUSES,
  sameEconomicCapabilityRequirement,
  sameRecipient,
  validateEconomicActionDraft,
} from "./domain";

// Ports: the durable storage + idempotency arbitration + admission seams.
export type {
  EconomicAdmissionEvidence,
  EconomicCapabilityAdmissionDecision,
  EconomicCapabilityAdmissionInput,
  EconomicCapabilityAdmissionPort,
  EconomicPolicyAdmissionDecision,
  EconomicPolicyAdmissionInput,
  EconomicPolicyAdmissionPort,
  EconomicStore,
  EconomicsIdempotencyArbitration,
  EconomicsIdempotencyPort,
  EconomicsIdempotencyScope,
  EconomicsTx,
} from "./ports";
export { canonicalEconomicFingerprint } from "./ports";
