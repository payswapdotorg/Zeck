/**
 * Machine-payment / HTTP 402 interoperability (economics module domain;
 * WORK-032, ECO-005; ADR-0018 "HTTP 402 / machine commerce").
 *
 * A machine-readable payment-required response (HTTP 402 with neutral
 * price/terms) is an INPUT to economic planning — NEVER an authorization:
 *
 * ```text
 * request -> 402 Payment Required -> machine-readable price/terms
 *   -> Zeck economic decision (an EconomicAction proposal through the
 *      FULL chain: policy -> capability -> budget -> authorization)
 *   -> authorized payment -> retry/resource delivery
 * ```
 *
 * This file is a pure PARSER + planner-facing projection. It produces a
 * `PaymentRequiredSignal` (advisory data) and can seed an EconomicAction
 * DRAFT; it cannot mint, satisfy or bypass an authorization. There is no
 * function here that produces an authorization, and the service exposes no
 * path from a signal to an authorized charge (the discrimination suite
 * proves a 402 signal never authorizes anything).
 *
 * Neutrality: the parsed shape is Zeck's own closed vocabulary — no
 * provider protocol identifier, no rail SDK type, no raw credentials.
 */

import type { EconomicCapabilityRequirement } from "./capabilities";
import type { EconomicActionDraft } from "./economic-action";
import { validateEconomicActionDraft } from "./economic-action";
import type { EconomicMicroUsd } from "./money";
import { isEconomicMicroUsd } from "./money";
import type { EconomicCurrency, RecipientKind, RecipientReference } from "./vocabulary";
import { isEconomicCurrency } from "./vocabulary";

/** The machine-payment signal contract version. */
export const PAYMENT_REQUIRED_SIGNAL_SCHEMA_VERSION = 1;

export const HTTP_PAYMENT_REQUIRED = 402;

/** The closed, neutral body vocabulary a 402 signal must carry. */
export interface PaymentRequiredTerms {
  readonly payee: RecipientReference;
  readonly amountMicroUsd: EconomicMicroUsd;
  readonly currency: EconomicCurrency;
  /** What is being sold (opaque resource reference). */
  readonly resource: string;
  /** Neutral rail ids the seller accepts (opaque strings). */
  readonly accepts?: readonly string[];
}

/** The advisory signal (NEVER an authorization — ECO-005). */
export interface PaymentRequiredSignal {
  readonly schemaVersion: number;
  readonly statusCode: number;
  readonly advisory: true;
  readonly terms: PaymentRequiredTerms;
  /** Where the signal was observed (provenance, opaque). */
  readonly observedAtUrl?: string;
}

export type PaymentRequiredParseCode =
  | "not-payment-required"
  | "body-not-object"
  | "missing-terms"
  | "invalid-terms";

export type PaymentRequiredParseResult =
  | { readonly parsed: true; readonly signal: PaymentRequiredSignal }
  | { readonly parsed: false; readonly code: PaymentRequiredParseCode; readonly detail: string };

const PAYEE_KINDS: readonly RecipientKind[] = ["seller", "merchant", "provider"];

/**
 * Parse a machine-payment payment-required response into the neutral
 * advisory signal. Only `statusCode === 402` with a well-formed neutral
 * terms object parses; everything else fails closed with a typed code.
 * The result carries an `advisory: true` marker by construction.
 */
export function parsePaymentRequiredSignal(input: {
  readonly statusCode: number;
  readonly url?: string;
  readonly body: unknown;
}): PaymentRequiredParseResult {
  if (input.statusCode !== HTTP_PAYMENT_REQUIRED) {
    return {
      parsed: false,
      code: "not-payment-required",
      detail: `statusCode ${input.statusCode} is not 402 Payment Required`,
    };
  }
  if (typeof input.body !== "object" || input.body === null || Array.isArray(input.body)) {
    return { parsed: false, code: "body-not-object", detail: "402 body must be a JSON object" };
  }
  const record = input.body as Record<string, unknown>;
  const terms = record.terms;
  if (typeof terms !== "object" || terms === null || Array.isArray(terms)) {
    return {
      parsed: false,
      code: "missing-terms",
      detail: '402 body must carry a "terms" object (machine-readable price/terms)',
    };
  }
  const termsRecord = terms as Record<string, unknown>;
  const payeeKind = termsRecord.payeeKind;
  const payeeId = termsRecord.payeeId;
  const amountMicroUsd = termsRecord.amountMicroUsd;
  const currency = termsRecord.currency;
  const resource = termsRecord.resource;
  const accepts = termsRecord.accepts;
  if (
    typeof payeeKind !== "string" ||
    !PAYEE_KINDS.includes(payeeKind as RecipientKind) ||
    typeof payeeId !== "string" ||
    payeeId.length === 0 ||
    payeeId.length > 512
  ) {
    return {
      parsed: false,
      code: "invalid-terms",
      detail: "terms.payeeKind must be seller|merchant|provider and terms.payeeId a 1..512 string",
    };
  }
  if (!isEconomicMicroUsd(amountMicroUsd)) {
    return {
      parsed: false,
      code: "invalid-terms",
      detail: "terms.amountMicroUsd must be a non-negative integer micro-USD decimal string",
    };
  }
  if (typeof currency !== "string" || !isEconomicCurrency(currency)) {
    return {
      parsed: false,
      code: "invalid-terms",
      detail: "terms.currency must be one of the supported provider-neutral currencies",
    };
  }
  if (typeof resource !== "string" || resource.length === 0 || resource.length > 512) {
    return {
      parsed: false,
      code: "invalid-terms",
      detail: "terms.resource must be a 1..512 string",
    };
  }
  if (
    accepts !== undefined &&
    (!Array.isArray(accepts) || accepts.some((id) => typeof id !== "string"))
  ) {
    return {
      parsed: false,
      code: "invalid-terms",
      detail: "terms.accepts must be an array of opaque rail id strings",
    };
  }
  return {
    parsed: true,
    signal: {
      schemaVersion: PAYMENT_REQUIRED_SIGNAL_SCHEMA_VERSION,
      statusCode: HTTP_PAYMENT_REQUIRED,
      advisory: true,
      terms: {
        payee: { kind: payeeKind as RecipientKind, id: payeeId },
        amountMicroUsd,
        currency,
        resource,
        ...(accepts === undefined ? {} : { accepts: accepts as readonly string[] }),
      },
      ...(input.url === undefined ? {} : { observedAtUrl: input.url }),
    },
  };
}

/**
 * Seed an EconomicAction DRAFT from a parsed signal — the planning INPUT
 * path (ECO-005): the caller supplies the governing scope (server-derived
 * tenant/application/execution identity), the expiry window and any
 * capability requirements. The draft is UNVALIDATED here and must pass
 * `validateEconomicActionDraft` + the FULL authorization chain before any
 * charge — a 402 signal by itself authorizes NOTHING.
 */
export function economicActionDraftFromSignal(
  signal: PaymentRequiredSignal,
  scope: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly executionId: string;
    readonly proposedBy: string;
  },
  window: {
    readonly expiresAt: string;
    readonly requiredCapabilities?: readonly EconomicCapabilityRequirement[];
  },
): EconomicActionDraft {
  return {
    applicationId: scope.applicationId,
    tenantId: scope.tenantId,
    executionId: scope.executionId,
    proposedBy: scope.proposedBy,
    purpose: "machine-resource",
    recipient: signal.terms.payee,
    amount: { kind: "exact", microUsd: signal.terms.amountMicroUsd },
    currency: signal.terms.currency,
    expiresAt: window.expiresAt,
    requiredCapabilities: window.requiredCapabilities ?? [],
    metadata: {
      origin: "http-402",
      resource: signal.terms.resource,
      ...(signal.observedAtUrl === undefined ? {} : { observedAtUrl: signal.observedAtUrl }),
    },
  };
}

/** Exposed for planner-facing validation reuse (the signal is data only). */
export { validateEconomicActionDraft as validateDraftForPlanning };
