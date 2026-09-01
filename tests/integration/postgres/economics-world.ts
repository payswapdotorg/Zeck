/**
 * Shared real-PostgreSQL fixture for the economics suites (WORK-032).
 *
 * Seeds the full governed economic-action fabric over the disposable
 * real-PostgreSQL database (the budgets-world / executions-world pattern):
 *
 *   * executions: the REAL SQL authority (SqlExecutionStore +
 *     SqlExecutionsIdempotency + the execution service) — economic actions
 *     FK to a real execution and their boundary events ride the canonical
 *     executions ledger through `recordStepEvent`;
 *   * budgets: the REAL SQL authority (SqlBudgetStore +
 *     SqlBudgetsIdempotency + the budget service) with a funded developer
 *     wallet — reserve/settle land on the REAL budgets ledger (migration
 *     0003), never a second ledger (ECO-003);
 *   * economics: SqlEconomicStore + SqlEconomicsIdempotency (migration
 *     0014; idempotency arbitration reuses platform.idempotency_records
 *     from 0001) + the REAL economic-action service;
 *   * admission seams: small recording ALLOW fakes for policy/capability
 *     (the real adapters' own PG suites prove the authorities; here the
 *     fakes pin the chain ORDER: policy -> capability -> budget reserve ->
 *     issuance -> rail charge -> budget settle);
 *   * a second tenant + application for the cross-tenant/cross-application
 *     isolation proofs.
 */

import {
  SqlBudgetStore,
  SqlBudgetsIdempotency,
} from "../../../src/modules/budgets/adapters/sql-budget-store";
import {
  type BudgetService,
  createBudgetService,
} from "../../../src/modules/budgets/application/budget-service";
import {
  type CreateEconomicActionCommand,
  createEconomicActionService,
  createSqlEconomicsModule,
  type EconomicActionService,
  type EconomicCapabilityAdmissionInput,
  type EconomicCapabilityAdmissionPort,
  type EconomicPolicyAdmissionInput,
  type EconomicPolicyAdmissionPort,
  type SqlEconomicStore,
} from "../../../src/modules/economics/public";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";

export const generateId = createUuidv7Generator();
export const ACTOR_ID = "00000000-0000-7000-8000-0000000000aa";

/** Recording policy admission: the hard authorization boundary seam (allow). */
class AllowingPolicyAdmission implements EconomicPolicyAdmissionPort {
  readonly calls: EconomicPolicyAdmissionInput[] = [];

  async evaluate(input: EconomicPolicyAdmissionInput) {
    this.calls.push(input);
    return {
      allowed: true,
      evidence: {
        policySetId: "pg-econ-set",
        policySetVersion: 1,
        policyContentHash: "pg-econ-hash",
        restrictionSetDigest: "pg-econ-digest",
      },
    };
  }
}

/** Recording capability admission: the capabilities authority seam (allow). */
class AllowingCapabilityAdmission implements EconomicCapabilityAdmissionPort {
  readonly calls: EconomicCapabilityAdmissionInput[] = [];

  async resolve(input: EconomicCapabilityAdmissionInput) {
    this.calls.push(input);
    return { satisfied: true, unmet: [] };
  }
}

export interface EconomicsPgWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  /** A second, unrelated tenant + application (isolation proofs). */
  readonly otherTenantId: string;
  readonly otherApplicationId: string;
  readonly actorId: string;
  readonly executionId: string;
  readonly economics: EconomicActionService;
  readonly store: SqlEconomicStore;
  readonly budget: BudgetService;
  readonly executions: ExecutionService;
  /** The funded developer wallet (budgets 0003 real ledger). */
  readonly walletId: string;
  /** The admission fakes (call evidence for the ordering proofs). */
  readonly policy: AllowingPolicyAdmission;
  readonly capabilities: AllowingCapabilityAdmission;
}

export interface SeedEconomicsWorldOptions {
  /** Developer wallet grant in micro-USD (default "1000000"). */
  readonly grantMicroUsd?: string;
}

export async function seedEconomicsWorld(
  db: DatabasePort,
  options: SeedEconomicsWorldOptions = {},
): Promise<EconomicsPgWorld> {
  const tenantId = generateId();
  const applicationId = generateId();
  const otherTenantId = generateId();
  const otherApplicationId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "economics tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "economics app"],
  });
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [otherTenantId, `t-${otherTenantId.slice(-6)}`, "other tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [
      otherApplicationId,
      otherTenantId,
      `a-${otherApplicationId.slice(-6)}`,
      "other app",
    ],
  });

  // Executions: the REAL SQL authority (the provenance + ledger seam).
  const executions = createExecutionService({
    store: new SqlExecutionStore(db),
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: { evaluate: async () => ({ allowed: true }) },
    generateId,
    now: () => new Date(),
  });
  const actor = { actorId: ACTOR_ID, tenantId };
  const receipt = await executions.createExecution(
    { applicationId, task: { kind: "summarize", input: "artifact-1" } },
    "econ-seed-execution",
    actor,
  );

  // Budgets: the REAL SQL authority with a funded developer wallet.
  const budget = createBudgetService({
    store: new SqlBudgetStore(db),
    idempotency: new SqlBudgetsIdempotency(db, (tx) => new SqlBudgetStore(tx), generateId),
    generateId,
    now: () => new Date(),
  });
  const scope = { actorId: ACTOR_ID, applicationId, tenantId };
  await budget.configureFundingMode({ ...scope, fundingMode: "developer" }, "econ-seed-funding");
  await budget.grantCredits(
    { ...scope, ownerKind: "developer", amountMicroUsd: options.grantMicroUsd ?? "1000000" },
    "econ-seed-grant",
  );
  const wallet = await db.execute<{ id: string }>({
    sql: "SELECT id FROM budgets.wallets WHERE application_id = $1 AND owner_kind = 'developer'",
    parameters: [applicationId],
  });
  const walletId = wallet.rows[0]?.id;
  if (walletId === undefined) {
    throw new Error("seeded developer wallet not found");
  }

  // Economics: the REAL SQL fabric (0014) + the REAL service; the budget
  // seam is the REAL budgets authority above (reserve/settle on 0003).
  const policy = new AllowingPolicyAdmission();
  const capabilities = new AllowingCapabilityAdmission();
  const { store, idempotency } = createSqlEconomicsModule(db, generateId);
  const economics = createEconomicActionService({
    store,
    idempotency,
    policy,
    capabilities,
    budget,
    executions,
    generateId,
    now: () => new Date(),
  });

  return {
    db,
    tenantId,
    applicationId,
    otherTenantId,
    otherApplicationId,
    actorId: ACTOR_ID,
    executionId: receipt.executionId,
    economics,
    store,
    budget,
    executions,
    walletId,
    policy,
    capabilities,
  };
}

/** The command scope every economics command carries. */
export function scopeOf(world: EconomicsPgWorld) {
  return {
    actorId: world.actorId,
    applicationId: world.applicationId,
    tenantId: world.tenantId,
  };
}

/** A valid range-bounded create command bound to the world's execution. */
export function createCommand(
  world: EconomicsPgWorld,
  overrides: Partial<CreateEconomicActionCommand> = {},
): CreateEconomicActionCommand {
  return {
    ...scopeOf(world),
    executionId: world.executionId,
    purpose: "purchase",
    recipient: { kind: "merchant", id: "merchant-42" },
    amount: { kind: "range", minMicroUsd: "100000", maxMicroUsd: "200000" },
    currency: "usd",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    requiredCapabilities: [{ kind: "tool", name: "payment-processor" }],
    ...overrides,
  };
}

/** The live developer wallet balance (real budgets ledger projection). */
export async function balanceOf(db: DatabasePort, walletId: string): Promise<string> {
  const result = await db.execute<{ balance_micro_usd: string }>({
    sql: "SELECT balance_micro_usd FROM budgets.wallets WHERE id = $1",
    parameters: [walletId],
  });
  return result.rows[0]?.balance_micro_usd ?? "missing";
}

/** The wallet's append-only ledger trail: class:direction:amount rows. */
export async function ledgerOf(db: DatabasePort, walletId: string): Promise<readonly string[]> {
  const result = await db.execute<{
    entry_class: string;
    direction: string;
    amount_micro_usd: string;
  }>({
    sql: "SELECT entry_class, direction, amount_micro_usd FROM budgets.ledger_entries WHERE wallet_id = $1 ORDER BY occurred_at, id",
    parameters: [walletId],
  });
  return result.rows.map((r) => `${r.entry_class}:${r.direction}:${r.amount_micro_usd}`);
}

/** The budgets reservation row for an economics reservation operation. */
export async function reservationOf(db: DatabasePort, operationId: string) {
  const result = await db.execute<{
    id: string;
    status: string;
    amount_micro_usd: string;
    settled_amount_micro_usd: string | null;
    wallet_id: string | null;
    month_key: string;
  }>({
    sql: "SELECT id, status, amount_micro_usd, settled_amount_micro_usd, wallet_id, month_key FROM budgets.reservations WHERE operation_id = $1",
    parameters: [operationId],
  });
  return result.rows[0] ?? null;
}
