/**
 * Public contract barrel of the `budgets` module.
 *
 * This file is the ONLY supported import surface for other modules and for
 * the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public
 * module rule"). Everything else under `src/modules/budgets/` is private to
 * this module.
 *
 * WORK-004 introduces the economic authority surface: funding modes and
 * precedence, wallets, budget limits with deterministic evaluation
 * precedence, transactional/idempotent reservations, exactly-once
 * settlement and release, and the append-only ledger.
 *
 * The surface executions (WORK-006) will consult before dispatch is
 * `BudgetAuthority` — reserve before billable work, settle actual usage
 * once, release unused holds once. There is deliberately no default-allow
 * admission here: an application without a configured funding policy is
 * denied (`POLICY_DENIED`), never silently allowed.
 */

import type { ModuleDescriptor } from "../../shared/module";
import type { BudgetService } from "./application/budget-service";
import { createBudgetService } from "./application/budget-service";

export const moduleDescriptor: ModuleDescriptor = { id: "budgets" };

// Application services + commands/outcomes.
export type {
  BudgetService,
  ConfigureFundingModeCommand,
  ConfigureFundingOutcome,
  GrantCreditsCommand,
  GrantCreditsOutcome,
  ReleaseCommand,
  ReleaseOutcome,
  ReserveCommand,
  ReserveOutcome,
  SetBudgetCommand,
  SetBudgetOutcome,
  SettleCommand,
  SettleOutcome,
} from "./application/budget-service";
// Domain vocabulary (BUD-001..BUD-005; money is integer micro-USD strings).
export type { BudgetRecord, BudgetScopeKind } from "./domain/budget";
export { BUDGET_CHECK_ORDER } from "./domain/budget";
export type { FundingMode, FundingSourceKind, WalletOwnerKind } from "./domain/funding";
export {
  eligibleWalletSources,
  FUNDING_MODES,
  FUNDING_PRECEDENCE,
  isFundingMode,
  modeRequiresUser,
} from "./domain/funding";
export type { MicroUsd } from "./domain/money";
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
} from "./domain/money";
export type { ReservationRecord, ReservationStatus } from "./domain/reservation";
export type {
  FundingSettings,
  LedgerDirection,
  LedgerEntryClass,
  LedgerEntryRecord,
  WalletRecord,
} from "./domain/wallet";
export type { BudgetsIdempotencyPort } from "./ports/budget-idempotency";
// Module ports (provider-neutral; implemented by adapters).
export type { BudgetStore } from "./ports/budget-store";
export { createBudgetService };

/**
 * The durable budget admission surface Executions consult before dispatch
 * (`IMPLEMENTATION.md` §7: budget reservation precedes the adapter call).
 * Structural pick keeps the dependency minimal.
 */
export type BudgetAuthority = Pick<BudgetService, "reserve" | "settle" | "release">;
/** Command scopes of the authority surface (always server-derived context). */
export type BudgetAuthorityReserveCommand = Parameters<BudgetAuthority["reserve"]>[0];
