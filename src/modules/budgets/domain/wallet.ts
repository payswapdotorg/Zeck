/**
 * Wallet, funding-policy and ledger entities (budgets module domain).
 *
 * Public record shapes only — no secrets exist in this module (there is
 * nothing to redact), and no money field is ever a number: balances and
 * amounts are canonical decimal strings of integer micro-USD
 * (`domain/money.ts`).
 */

import type { WalletOwnerKind } from "./funding";

/** A funding wallet: developer funds, one user's funds, or subsidy credits. */
export interface WalletRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly ownerKind: WalletOwnerKind;
  /** End-user identity for `user` wallets; '' for application-level wallets. */
  readonly ownerId: string;
  readonly currency: "usd-micro";
  readonly balanceMicroUsd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Application funding policy — the durable policy row the reservation
 * evaluator consults (BUD-003 "supported by policy"). Its absence fails
 * reservation admission closed (no default-allow funding exists).
 */
export interface FundingSettings {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly fundingMode: string;
  /** BUD-002: whether user-imposed limits are enforced for this application. */
  readonly allowUserLimits: boolean;
  readonly updatedAt: string;
}

/** Movement classes of the append-only ledger (BUD-005). */
export type LedgerEntryClass =
  | "reservation-hold"
  | "settle-overage"
  | "settle-release"
  | "reservation-release"
  | "credit-grant"
  | "correction";

export type LedgerDirection = "debit" | "credit";

/** One append-only ledger entry — a movement of money, never mutated. */
export interface LedgerEntryRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly walletId: string;
  readonly reservationId: string | null;
  readonly entryClass: LedgerEntryClass;
  readonly direction: LedgerDirection;
  readonly amountMicroUsd: string;
  readonly monthKey: string;
  readonly memo: string | null;
  readonly occurredAt: string;
}
