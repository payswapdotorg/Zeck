/**
 * Closed economic vocabularies (economics module domain; WORK-032).
 *
 * Provider-neutral, frozen vocabularies — the ECO-001/ECO-002 contract
 * surface. No rail slug, provider name, SDK type or provider-specific
 * protocol identifier may appear here (the neutrality scanners pin this).
 */

/** Payment is one class among several economic-action classes (ADR-0018). */
export const ECONOMIC_PURPOSES = [
  "purchase",
  "payment",
  "transfer",
  "refund",
  "charge",
  "machine-resource",
] as const;

export type EconomicPurpose = (typeof ECONOMIC_PURPOSES)[number];

export function isEconomicPurpose(value: string): value is EconomicPurpose {
  return (ECONOMIC_PURPOSES as readonly string[]).includes(value);
}

/**
 * Provider-neutral currency vocabulary (ISO-4217 lowercase codes). The
 * platform accounting currency for budgets is micro-USD; a non-USD
 * economic action must be expressible by the rail AND admitted by policy,
 * and its budget reservation is still denominated in micro-USD by the
 * application's declared conversion basis (a caller-supplied conversion
 * is never trusted — the budgets authority owns the reservation).
 */
export const ECONOMIC_CURRENCIES = ["usd", "eur", "gbp", "jpy", "cad", "aud", "chf"] as const;

export type EconomicCurrency = (typeof ECONOMIC_CURRENCIES)[number];

export function isEconomicCurrency(value: string): value is EconomicCurrency {
  return (ECONOMIC_CURRENCIES as readonly string[]).includes(value);
}

/** Recipient/seller reference kinds (opaque external references). */
export const RECIPIENT_KINDS = ["seller", "merchant", "provider", "wallet", "account"] as const;

export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

export interface RecipientReference {
  readonly kind: RecipientKind;
  /** Opaque external recipient identifier (never a credential). */
  readonly id: string;
}

export function isRecipientKind(value: string): value is RecipientKind {
  return (RECIPIENT_KINDS as readonly string[]).includes(value);
}

/** Recipient equality is the FULL pinned reference (kind + id). */
export function sameRecipient(a: RecipientReference, b: RecipientReference): boolean {
  return a.kind === b.kind && a.id === b.id;
}
