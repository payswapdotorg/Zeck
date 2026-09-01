/**
 * The Economic Action entity and payment-intent contract (economics module
 * domain; WORK-032, ECO-001; ADR-0018).
 *
 * An Economic Action is the provider-neutral INTENT that an agent (or
 * developer) wants to cause an externally settled transaction: a purchase,
 * a payment, a transfer, a refund, a charge or a future machine-commerce
 * operation. Payment is ONE class of economic action, not the concept.
 *
 * THE IMPLEMENTATION PRINCIPLE (ADR-0018, frozen):
 *
 * ```text
 * intent != authorization != transaction != settlement != verification
 * ```
 *
 * This file owns the INTENT ONLY. An `EconomicActionRecord` is never an
 * authorization (the bounded payment authorization is `authorization.ts`),
 * never a settlement (settlement observations are correlated external
 * evidence — `settlement.ts`) and never a verification of delivery
 * (`delivery.ts` + the verification module own that).
 *
 * The contract is content- and context-bound (ADR-0018): actor, execution,
 * tenant/application, purpose, recipient/seller, bounded amount/currency,
 * expiration, idempotency identity and required capabilities — every
 * material constraint participates in the request fingerprint, so an
 * authorization minted for one action cannot be replayed against a
 * different recipient/amount/currency/purpose.
 *
 * Provider neutrality: NO rail identifier, provider name or SDK type
 * crosses this contract. `railPreference` is an opaque neutral string at
 * most; recipient identifiers are opaque external references.
 */

import type { EconomicCapabilityRequirement } from "./capabilities";
import type { EconomicMicroUsd } from "./money";
import { compareEconomicMicroUsd, isEconomicMicroUsd } from "./money";
import type { EconomicCurrency, EconomicPurpose, RecipientReference } from "./vocabulary";
import {
  ECONOMIC_CURRENCIES,
  ECONOMIC_PURPOSES,
  isEconomicCurrency,
  isEconomicPurpose,
  isRecipientKind,
} from "./vocabulary";

/** Bounded amount: exact or an explicit range (ADR-0018 "bounded amount range"). */
export type EconomicAmount =
  | { readonly kind: "exact"; readonly microUsd: EconomicMicroUsd }
  | {
      readonly kind: "range";
      readonly minMicroUsd: EconomicMicroUsd;
      readonly maxMicroUsd: EconomicMicroUsd;
    };

export interface EconomicActionDraft {
  readonly applicationId: string;
  readonly tenantId: string;
  /** The logical execution this economic action belongs to (provenance binding). */
  readonly executionId: string;
  /** Actor that proposes the intent (provenance identity — never an approver). */
  readonly proposedBy: string;
  readonly purpose: EconomicPurpose;
  readonly recipient: RecipientReference;
  readonly amount: EconomicAmount;
  readonly currency: EconomicCurrency;
  /** Intent expiry (ISO-8601 UTC instant); never extendable after creation. */
  readonly expiresAt: string;
  readonly requiredCapabilities: readonly EconomicCapabilityRequirement[];
  /**
   * Opaque neutral rail preference (never an SDK handle, never required by
   * the core contracts — the composition root resolves it to an adapter).
   */
  readonly railPreference?: string;
  /** Caller provenance metadata (never authorization material). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export const ECONOMIC_ACTION_STATUSES = [
  "proposed",
  "denied",
  "authorized",
  "executing",
  "settled",
  "failed",
  "expired",
] as const;

export type EconomicActionStatus = (typeof ECONOMIC_ACTION_STATUSES)[number];

/** Terminal action statuses (physically immutable in migration 0014). */
export const ECONOMIC_ACTION_TERMINAL_STATUSES: readonly EconomicActionStatus[] = [
  "denied",
  "settled",
  "failed",
  "expired",
];

/** The frozen action lifecycle (forward-only; terminal rows are immutable). */
export const ECONOMIC_ACTION_TRANSITIONS: Readonly<
  Record<EconomicActionStatus, readonly EconomicActionStatus[]>
> = {
  proposed: ["authorized", "denied", "expired"],
  denied: [],
  authorized: ["executing", "expired"],
  executing: ["settled", "failed"],
  settled: [],
  failed: [],
  expired: [],
};

export function isEconomicActionStatus(value: string): value is EconomicActionStatus {
  return (ECONOMIC_ACTION_STATUSES as readonly string[]).includes(value);
}

export function economicActionCanTransition(
  from: EconomicActionStatus,
  to: EconomicActionStatus,
): boolean {
  return ECONOMIC_ACTION_TRANSITIONS[from].includes(to);
}

/** The durable Economic Action (public record shape). */
export interface EconomicActionRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  /** Actor that proposed the intent (provenance; NOT an approver). */
  readonly proposedBy: string;
  readonly purpose: EconomicPurpose;
  readonly recipient: RecipientReference;
  readonly amount: EconomicAmount;
  readonly currency: EconomicCurrency;
  readonly expiresAt: string;
  readonly requiredCapabilities: readonly EconomicCapabilityRequirement[];
  readonly railPreference: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly status: EconomicActionStatus;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EconomicActionValidationIssue {
  readonly field: string;
  readonly message: string;
}

/**
 * Deterministic, total draft validation (ECO-001): closed vocabulary,
 * bounded amount, expiry in the future, non-empty scope identities and
 * required-capability shape. Fail-closed: every issue is typed; nothing
 * is silently coerced or defaulted.
 */
export function validateEconomicActionDraft(
  draft: EconomicActionDraft,
  now: Date,
): readonly EconomicActionValidationIssue[] {
  const issues: EconomicActionValidationIssue[] = [];
  if (draft.applicationId.length === 0) {
    issues.push({ field: "applicationId", message: "applicationId is required" });
  }
  if (draft.tenantId.length === 0) {
    issues.push({ field: "tenantId", message: "tenantId is required (server-derived scope)" });
  }
  if (draft.executionId.length === 0) {
    issues.push({ field: "executionId", message: "executionId is required (provenance binding)" });
  }
  if (draft.proposedBy.length === 0) {
    issues.push({ field: "proposedBy", message: "proposedBy actor is required" });
  }
  if (!isEconomicPurpose(draft.purpose)) {
    issues.push({
      field: "purpose",
      message: `purpose must be one of ${ECONOMIC_PURPOSES.join(", ")}`,
    });
  }
  if (!isRecipientKind(draft.recipient.kind)) {
    issues.push({
      field: "recipient.kind",
      message: "recipient.kind is outside the closed vocabulary",
    });
  }
  if (draft.recipient.id.length === 0 || draft.recipient.id.length > 512) {
    issues.push({ field: "recipient.id", message: "recipient.id must be 1..512 chars" });
  }
  if (!isEconomicCurrency(draft.currency)) {
    issues.push({
      field: "currency",
      message: `currency must be one of ${ECONOMIC_CURRENCIES.join(", ")}`,
    });
  }
  if (draft.amount.kind === "exact") {
    if (!isEconomicMicroUsd(draft.amount.microUsd)) {
      issues.push({
        field: "amount.microUsd",
        message: "exact amount must be a non-negative integer micro-USD decimal string",
      });
    }
  } else {
    if (
      !isEconomicMicroUsd(draft.amount.minMicroUsd) ||
      !isEconomicMicroUsd(draft.amount.maxMicroUsd)
    ) {
      issues.push({
        field: "amount",
        message: "range bounds must be non-negative integer micro-USD decimal strings",
      });
    } else if (compareEconomicMicroUsd(draft.amount.minMicroUsd, draft.amount.maxMicroUsd) > 0) {
      issues.push({ field: "amount", message: "range min must not exceed max" });
    }
  }
  const expiresAt = Date.parse(draft.expiresAt);
  if (Number.isNaN(expiresAt)) {
    issues.push({ field: "expiresAt", message: "expiresAt must be an ISO-8601 instant" });
  } else if (expiresAt <= now.getTime()) {
    issues.push({ field: "expiresAt", message: "expiresAt must be in the future" });
  }
  for (const requirement of draft.requiredCapabilities) {
    if (requirement.name.length === 0 || requirement.name.length > 255) {
      issues.push({
        field: "requiredCapabilities",
        message: "capability name must be 1..255 chars",
      });
    }
    if (requirement.kind.length === 0 || requirement.kind.length > 64) {
      issues.push({
        field: "requiredCapabilities",
        message: "capability kind must be 1..64 chars",
      });
    }
  }
  return issues;
}

/**
 * The deterministic request fingerprint basis of an economic action: every
 * MATERIAL economic constraint participates (recipient, amount bounds,
 * currency, purpose, expiry, scope identities, capabilities, actor) — a mutated
 * constraint is a DIFFERENT logical operation (same idempotency key then
 * fails `IDEMPOTENCY_KEY_REUSED`, never silently replays).
 */
export function economicActionFingerprintParts(draft: EconomicActionDraft): readonly unknown[] {
  return [
    "economics.create-action",
    draft.applicationId,
    draft.tenantId,
    draft.executionId,
    draft.proposedBy,
    draft.purpose,
    draft.recipient.kind,
    draft.recipient.id,
    draft.amount.kind,
    draft.amount.kind === "exact" ? draft.amount.microUsd : null,
    draft.amount.kind === "range" ? draft.amount.minMicroUsd : null,
    draft.amount.kind === "range" ? draft.amount.maxMicroUsd : null,
    draft.currency,
    draft.expiresAt,
    draft.requiredCapabilities.map((requirement) => [
      requirement.kind,
      requirement.name,
      requirement.minVersion ?? "",
    ]),
    draft.railPreference ?? "",
  ];
}
