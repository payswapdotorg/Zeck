/**
 * `budgets` ports layer — outbound/inbound interfaces owned by this module.

Ports are provider-neutral: no infrastructure clients, no provider SDKs.
Adapters (in `adapters/`) implement them (`IMPLEMENTATION.md` §2–§3).
 */

export type {
  BudgetsIdempotencyArbitration,
  BudgetsIdempotencyPort,
  BudgetsIdempotencyScope,
  BudgetTx,
} from "./budget-idempotency";
export { canonicalFingerprint } from "./budget-idempotency";
export type {
  AppendLedgerEntryInput,
  BudgetStore,
  DecisionDomain,
  InsertReservationInput,
  InsertWalletInput,
  UpsertBudgetInput,
  UpsertFundingSettingsInput,
} from "./budget-store";
