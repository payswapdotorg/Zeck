/**
 * The declared minimal module seams of the Execution IR foundation
 * (platform execution-ir plane; WORK-049).
 *
 * Following the WORK-048 seam precedent (evacuation-seam /
 * recovery-invariants): this platform plane defines NEUTRAL seam
 * CONTRACTS; the owning modules implement them inside their own adapter
 * layers over their own authorities (`src/platform/**` never imports a
 * module). The seams are:
 *
 *  - `PlanDerivationSeam` — planning (plan derivation inputs): the
 *    module-side adapter converts a governed `ExecutionPlan` (plus its
 *    captured policy/capability planning inputs) into the neutral
 *    `GovernedPlanSnapshot` the IR derivation consumes. Read-only,
 *    pure, lossless;
 *  - `ExecutionBindingSeam` — executions (plan lifecycle / step
 *    identity): a READ-ONLY binding of an execution to its current
 *    governed plan identity (the executions ledger is the durable
 *    plan-decision authority);
 *  - `BudgetConstraintsSeam` — budgets (read-only cost constraints):
 *    READ-ONLY budget ceilings from the budgets authority. Never a
 *    reservation, settlement or admission surface — the budget
 *    authority stays canonical and untouched.
 *
 * No module may depend on this plane for authority (the dependency
 * direction is asserted by the architecture boundary tests; the only
 * module-side references to this plane are the three declared seam
 * adapter files).
 */

import type { GovernedPlanSnapshot } from "./ir";

/**
 * The executions-side plan binding: identity + lifecycle facts of the
 * governed plan currently bound to an execution. Read-only projection of
 * the executions authority (status vocabulary stays owned by the
 * executions module; this seam carries it as a bounded opaque string).
 */
export interface ExecutionPlanBinding {
  readonly applicationId: string;
  readonly executionId: string;
  readonly tenantId: string;
  /** The execution's current status (executions-owned vocabulary). */
  readonly status: string;
  /** The governed plan currently bound to the execution, when one is. */
  readonly currentPlanId: string | null;
  /** The planning decision that selected it, when one exists. */
  readonly planningDecisionId: string | null;
  /** The durable ledger position at which the binding was read. */
  readonly lastEventSequence: number;
}

/** The executions seam: read-only execution → plan binding. */
export interface ExecutionBindingSeam {
  getPlanBinding(applicationId: string, executionId: string): Promise<ExecutionPlanBinding | null>;
}

/**
 * Read-only budget cost constraints from the budgets authority: the
 * active budget ceilings for an application scope, exactly as the
 * budgets module defines them (integer micro-USD limits per scope).
 */
export interface BudgetCostFact {
  readonly budgetId: string;
  readonly scopeKind: string;
  /** End-user identity for user-monthly scopes; '' otherwise. */
  readonly userId: string;
  readonly limitMicroUsd: string;
}

export interface BudgetCostConstraints {
  readonly applicationId: string;
  readonly budgets: readonly BudgetCostFact[];
}

/** The budgets seam: read-only cost constraints (never admission). */
export interface BudgetConstraintsSeam {
  costConstraints(applicationId: string): Promise<BudgetCostConstraints | null>;
}

/**
 * The planning seam marker: the module-side adapter is a PURE converter
 * from the planning module's governed plan (its own domain) to the
 * neutral `GovernedPlanSnapshot` this plane derives from. The contract
 * here is the snapshot TYPE itself — the adapter's input types stay
 * module-owned (the platform never imports them).
 */
export type PlanDerivationSeam = {
  /**
   * Convert a governed plan (planning module domain) to the neutral
   * snapshot. Implementations are pure and must not re-derive plan
   * identity — the snapshot carries the planning authority's own
   * content-addressed `planId`, which `deriveExecutionIr` verifies
   * against the snapshot content.
   */
  toPlanSnapshot(plan: unknown): GovernedPlanSnapshot;
};
