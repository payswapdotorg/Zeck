/**
 * Shared real-PostgreSQL fixture for the budgets suites (WORK-004).
 *
 * Seeds a tenant + application (the budgets tables FK into
 * `applications.applications` through composite tenant keys) and wires the
 * full SQL fabric: SqlBudgetStore + SqlBudgetsIdempotency + the budget
 * service over the provider-neutral DatabasePort.
 */

import {
  SqlBudgetStore,
  SqlBudgetsIdempotency,
} from "../../../src/modules/budgets/adapters/sql-budget-store";
import {
  type BudgetService,
  createBudgetService,
} from "../../../src/modules/budgets/application/budget-service";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";

export const generateId = createUuidv7Generator();
export const ACTOR_ID = "00000000-0000-7000-8000-0000000000aa";

export interface BudgetWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly service: BudgetService;
}

export async function seedBudgetWorld(db: DatabasePort): Promise<BudgetWorld> {
  const tenantId = generateId();
  const applicationId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "budgets tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "budgets app"],
  });
  const idempotency = new SqlBudgetsIdempotency(db, (tx) => new SqlBudgetStore(tx), generateId);
  const service = createBudgetService({
    store: new SqlBudgetStore(db),
    idempotency,
    generateId,
    now: () => new Date(),
  });
  return { db, tenantId, applicationId, service };
}

export function scopeOf(world: BudgetWorld) {
  return { actorId: ACTOR_ID, applicationId: world.applicationId, tenantId: world.tenantId };
}

export async function balanceOf(db: DatabasePort, walletId: string): Promise<string> {
  const result = await db.execute<{ balance_micro_usd: string }>({
    sql: "SELECT balance_micro_usd FROM budgets.wallets WHERE id = $1",
    parameters: [walletId],
  });
  return result.rows[0]?.balance_micro_usd ?? "missing";
}

export async function walletIdOf(
  db: DatabasePort,
  applicationId: string,
  ownerKind: string,
  ownerId = "",
): Promise<string> {
  const result = await db.execute<{ id: string }>({
    sql: "SELECT id FROM budgets.wallets WHERE application_id = $1 AND owner_kind = $2 AND owner_id = $3",
    parameters: [applicationId, ownerKind, ownerId],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`wallet not found: ${ownerKind}/${ownerId}`);
  }
  return row.id;
}
