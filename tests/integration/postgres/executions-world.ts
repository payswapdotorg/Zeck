/**
 * Shared real-PostgreSQL fixture for the executions suites (WORK-006).
 *
 * Seeds a tenant + application + environment (the executions tables FK into
 * `applications.applications`/`applications.environments` through composite
 * tenant keys) and wires the full SQL fabric: SqlExecutionStore +
 * SqlExecutionsIdempotency + the execution service over the provider-neutral
 * DatabasePort.
 */

import {
  SqlBudgetStore,
  SqlBudgetsIdempotency,
} from "../../../src/modules/budgets/adapters/sql-budget-store";
import { createBudgetService } from "../../../src/modules/budgets/application/budget-service";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import type { ExecutionCreateInput } from "../../../src/modules/executions/domain/execution";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";

export const generateId = createUuidv7Generator();
export const ACTOR_ID = "00000000-0000-7000-8000-0000000000aa";

export interface ExecutionsWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly environmentId: string;
  readonly service: ExecutionService;
  readonly store: SqlExecutionStore;
}

export async function seedExecutionsWorld(db: DatabasePort): Promise<ExecutionsWorld> {
  const tenantId = generateId();
  const applicationId = generateId();
  const environmentId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "executions tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "executions app"],
  });
  await db.execute({
    sql: "INSERT INTO applications.environments (id, application_id, tenant_id, kind, name) VALUES ($1, $2, $3, $4, $5)",
    parameters: [environmentId, applicationId, tenantId, "production", "prod"],
  });
  const store = new SqlExecutionStore(db);
  const idempotency = new SqlExecutionsIdempotency(
    db,
    (tx) => new SqlExecutionStore(tx),
    generateId,
  );
  const service = createExecutionService({
    store,
    idempotency,
    authorization: { evaluate: async () => ({ allowed: true }) },
    generateId,
    now: () => new Date(),
  });
  return { db, tenantId, applicationId, environmentId, service, store };
}

export const actorOf = (world: ExecutionsWorld) => ({
  actorId: ACTOR_ID,
  tenantId: world.tenantId,
});

export function baseCreateInput(
  applicationId: string,
  environmentId?: string,
): ExecutionCreateInput {
  return {
    applicationId,
    environmentId,
    task: { kind: "summarize", input: "artifact-1" },
  };
}

export function transitionScope(world: ExecutionsWorld, executionId: string) {
  return { ...actorOf(world), applicationId: world.applicationId, executionId };
}

/** Wire a REAL budgets authority (WORK-004 fabric) for the dispatch seam. */
export function budgetAuthorityOver(db: DatabasePort) {
  const store = new SqlBudgetStore(db);
  const service = createBudgetService({
    store,
    idempotency: new SqlBudgetsIdempotency(db, (tx) => new SqlBudgetStore(tx), generateId),
    generateId,
    now: () => new Date(),
  });
  return service;
}
