/**
 * Environment-resolver adapter (deployments module adapter; WORK-023).
 *
 * Resolves the applications module's environment identities READ-ONLY
 * through the provider-neutral DatabasePort (the executions-store
 * precedent: `applications.environments` by id) — deployment identity
 * binds to a resolved environment, fail-closed when unknown. No
 * environment mutation surface exists.
 */

import type { DatabasePort } from "../../../platform/db/port";
import type { DeploymentEnvironmentResolver, EnvironmentRef } from "../ports/environment-resolver";

interface EnvironmentRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
}

export function createSqlEnvironmentResolver(db: DatabasePort): DeploymentEnvironmentResolver {
  return {
    async resolve(applicationId, environmentId): Promise<EnvironmentRef | null> {
      const result = await db.execute<EnvironmentRow>({
        sql: `SELECT e.id, e.application_id, a.tenant_id
FROM applications.environments e
JOIN applications.applications a ON a.id = e.application_id
WHERE e.id = $1`,
        parameters: [environmentId],
      });
      const row = result.rows[0];
      if (row === undefined || row.application_id !== applicationId) {
        return null;
      }
      return {
        environmentId: row.id,
        applicationId: row.application_id,
        tenantId: row.tenant_id,
      };
    },
  };
}
