/**
 * Budget scopes and evaluation precedence (budgets module domain;
 * BUD-001/BUD-002).
 *
 * BUD-001: applications impose per-execution and monthly budgets.
 * BUD-002: users impose their own spending limits where the application
 * permits it (`FundingSettings.allowUserLimits`).
 *
 * EVALUATION PRECEDENCE (frozen, deterministic): when several budget
 * checks would fail at once, the FIRST failing check in
 * `BUDGET_CHECK_ORDER` is THE denial reason — per-execution before
 * monthly before user-monthly, and budget denials always precede funding
 * insufficiency (the admission decision completes before money moves).
 * The order is fixed so two identical racing requests always produce the
 * same machine-readable denial, and so admission semantics never depend on
 * map iteration or evaluation timing.
 */

export type BudgetScopeKind = "per-execution" | "monthly" | "user-monthly";

/** The frozen budget-evaluation order. */
export const BUDGET_CHECK_ORDER: readonly BudgetScopeKind[] = [
  "per-execution",
  "monthly",
  "user-monthly",
];

/** Machine-readable denial reasons inside the canonical `BUDGET_EXCEEDED` code. */
export type BudgetDenialReason =
  | "execution-budget"
  | "monthly-budget"
  | "user-limit"
  | "insufficient-funds"
  | "insufficient-funds-at-settlement";

export const BUDGET_SCOPE_KINDS: readonly BudgetScopeKind[] = [
  "per-execution",
  "monthly",
  "user-monthly",
];

export function isBudgetScopeKind(value: string): value is BudgetScopeKind {
  return (BUDGET_SCOPE_KINDS as readonly string[]).includes(value);
}

/** A durable budget limit row (public shape; money is a decimal string). */
export interface BudgetRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly scopeKind: BudgetScopeKind;
  /** End-user identity for `user-monthly`; '' otherwise. */
  readonly userId: string;
  readonly limitMicroUsd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
