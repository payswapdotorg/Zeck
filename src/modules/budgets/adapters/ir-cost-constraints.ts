/**
 * The budgets-side IR cost-constraints seam (budgets module adapter;
 * WORK-049 — the module-side implementation of the platform
 * execution-ir plane's `BudgetConstraintsSeam`).
 *
 * The budgets module stays the economic authority (funding, admission,
 * reservations, settlement — all untouched); this adapter is a
 * READ-ONLY projection of the active budget ceilings for an
 * application scope, exactly as the budgets authority defines them
 * (integer micro-USD limits per scope). It is deliberately NOT a
 * reservation/admission surface: the platform IR foundation consumes
 * budget facts as constraints — it never redefines spending authority
 * (ADR-0020's rejected "separate cost ledger for optimization").
 */

import type { DatabasePort } from "../../../platform/db/port";
import type {
  BudgetConstraintsSeam,
  BudgetCostConstraints,
} from "../../../platform/execution-ir/seams";

interface BudgetRow {
  readonly id: string;
  readonly application_id: string;
  readonly scope_kind: string;
  readonly user_id: string;
  readonly limit_micro_usd: string;
}

/**
 * The budgets seam: read-only cost constraints over the budgets
 * module's own tables (the platform never queries them directly).
 */
export function createIrBudgetConstraints(db: DatabasePort): BudgetConstraintsSeam {
  return {
    async costConstraints(applicationId) {
      const result = await db.execute<BudgetRow>({
        sql: `SELECT id, application_id, scope_kind, user_id, limit_micro_usd::text AS limit_micro_usd
                FROM budgets.budgets
               WHERE application_id = $1
               ORDER BY created_at ASC, id ASC`,
        parameters: [applicationId],
      });
      const constraints: BudgetCostConstraints = {
        applicationId,
        budgets: result.rows.map((row) => ({
          budgetId: row.id,
          scopeKind: row.scope_kind,
          userId: row.user_id,
          limitMicroUsd: row.limit_micro_usd,
        })),
      };
      return constraints;
    },
  };
}
