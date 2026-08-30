/**
 * `budgets` application layer — use cases and orchestration local to this module.

Application code reaches outward only through this module's ports; it never
imports adapters or `src/platform/**` directly (`IMPLEMENTATION.md` §3).
 */
export type {
  BudgetCommandScope,
  BudgetService,
  BudgetServiceDeps,
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
} from "./budget-service";
export { createBudgetService } from "./budget-service";
