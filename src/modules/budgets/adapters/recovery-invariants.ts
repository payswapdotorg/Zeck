/**
 * The budgets-module recovery-invariants seam (WORK-048 / D-07 — the
 * module-side implementation of the platform recovery plane's
 * `ModuleInvariantSource`).
 *
 * The budgets tables are module-private surface: the D-07
 * recovered-authority gate verifies the frozen budget invariant
 * (wallet balances are never negative) through THIS adapter — the
 * platform never queries the module's tables directly.
 *
 * The check matters after a restore precisely because the restore
 * ran with triggers/CHECKs disabled: a corrupted or foreign restore
 * can leave a negative balance that the LIVE guards would never have
 * allowed.
 */

import type { DatabasePort } from "../../../platform/db/port";
import type {
  AuthorityInvariantViolation,
  ModuleInvariantSource,
} from "../../../platform/recovery/authority-verification";

export const BUDGET_RECOVERY_CHECKS = ["budget-wallet-non-negative"] as const;

/** The budgets module's recovered-state invariants. */
export function createBudgetRecoveryInvariants(db: DatabasePort): ModuleInvariantSource {
  return {
    module: "budgets",
    checks: [...BUDGET_RECOVERY_CHECKS],
    async verify(): Promise<readonly AuthorityInvariantViolation[]> {
      const violations: AuthorityInvariantViolation[] = [];
      const result = await db.execute<{ readonly count: string }>({
        sql: "SELECT count(*) AS count FROM budgets.wallets WHERE balance_micro_usd < 0",
        parameters: [],
      });
      const negative = Number(result.rows[0]?.count ?? 0);
      if (negative > 0) {
        violations.push({
          check: "budget-wallet-non-negative",
          detail: `${negative} wallets with negative balances (corrupted restore)`,
        });
      }
      return violations;
    },
  };
}
