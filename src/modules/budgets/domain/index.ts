/**
 * `budgets` domain layer — entities, invariants and value objects of this module.

Domain code may import this module's own layers, `src/shared/**` and other
modules' `public.ts` — never `src/platform/**`, adapters, provider SDKs or
HTTP libraries (`IMPLEMENTATION.md` §3).
 */
export type { BudgetDenialReason, BudgetRecord, BudgetScopeKind } from "./budget";
export { BUDGET_CHECK_ORDER, BUDGET_SCOPE_KINDS, isBudgetScopeKind } from "./budget";
export type { FundingMode, FundingSourceKind, WalletOwnerKind } from "./funding";
export {
  eligibleWalletSources,
  FUNDING_MODES,
  FUNDING_PRECEDENCE,
  isFundingMode,
  modeRequiresUser,
} from "./funding";
export type { MicroUsd } from "./money";
export {
  addMicroUsd,
  compareMicroUsd,
  greaterThan,
  isMicroUsd,
  isMonthKey,
  MAX_MICRO_USD,
  microUsdFromBigint,
  monthKeyOf,
  parseMicroUsd,
  subMicroUsd,
  toMicroUsdBigint,
} from "./money";
export type { ReservationRecord, ReservationStatus } from "./reservation";
export { isReservationStatus, RESERVATION_STATUSES } from "./reservation";
export type {
  FundingSettings,
  LedgerDirection,
  LedgerEntryClass,
  LedgerEntryRecord,
  WalletRecord,
} from "./wallet";
