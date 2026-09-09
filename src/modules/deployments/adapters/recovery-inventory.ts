/**
 * The deployments-module artifact-recovery seams (WORK-048 / D-07 —
 * the module-side implementation of the platform recovery plane's
 * `ArtifactInventorySource` and `ModuleInvariantSource`, the
 * worker-fabric seam precedent).
 *
 * The adoption ledger (`deployments.media_artifacts`) is the
 * deployments module's private surface — the D-07 artifact recovery
 * and the recovered-authority gate consume it through THIS adapter:
 * the platform never queries the module's tables directly.
 *
 * Owned here:
 *
 *   * `createArtifactInventorySource` — the authoritative INVENTORY
 *     scan (the recovery plan is EXACTLY the ledger; provider
 *     listings are never consulted) and the lineage-preservation
 *     proof (every entry's digest/parents/deployment chain still
 *     resolve in the authority);
 *   * `createArtifactLedgerRecoveryInvariants` — the recovered-state
 *     checks: adoption digests are well-formed 64-hex (content
 *     identity) and every adoption row's
 *     job → deployment → application → tenant chain resolves
 *     (referential integrity across the FK-disabled restore
 *     boundary).
 */

import type { DatabasePort } from "../../../platform/db/port";
import type {
  ArtifactInventoryEntry,
  ArtifactInventoryScan,
  ArtifactInventorySource,
  LineagePreservationReport,
} from "../../../platform/recovery/artifact-recovery";
import { storageKeyOf } from "../../../platform/recovery/artifact-recovery";
import type {
  AuthorityInvariantViolation,
  ModuleInvariantSource,
} from "../../../platform/recovery/authority-verification";

export const ARTIFACT_LEDGER_RECOVERY_CHECKS = [
  "artifact-adoption-digest-shape",
  "artifact-adoption-chain-resolution",
] as const;

const DIGEST_SHAPE = /^[0-9a-f]{64}$/;

/**
 * The deployments module's authoritative inventory source (the
 * recovery plan is the adoption ledger, read-only).
 */
export function createArtifactInventorySource(db: DatabasePort): ArtifactInventorySource {
  return {
    async scan(): Promise<ArtifactInventoryScan> {
      const result = await db.execute<{
        readonly application_id: string;
        readonly tenant_id: string;
        readonly artifact_key: string;
        readonly artifact_digest: string;
        readonly parent_digests: unknown;
        readonly deployment_id: string;
        readonly job_id: string;
        readonly execution_id: string;
        readonly role: string;
      }>({
        sql: `SELECT application_id, tenant_id, artifact_key, artifact_digest,
                     parent_digests, deployment_id, job_id, execution_id, role
              FROM deployments.media_artifacts
              ORDER BY application_id, artifact_key`,
        parameters: [],
      });
      const malformedDigests: string[] = [];
      const entries: ArtifactInventoryEntry[] = [];
      for (const row of result.rows) {
        const parents = Array.isArray(row.parent_digests)
          ? (row.parent_digests as unknown[]).filter(
              (parent): parent is string => typeof parent === "string",
            )
          : [];
        const entry = {
          applicationId: row.application_id,
          tenantId: row.tenant_id,
          artifactKey: row.artifact_key,
          artifactDigest: row.artifact_digest,
          parentDigests: Object.freeze([...parents]),
          deploymentId: row.deployment_id,
          jobId: row.job_id,
          executionId: row.execution_id,
          role: row.role,
        };
        if (!DIGEST_SHAPE.test(row.artifact_digest)) {
          malformedDigests.push(row.artifact_key);
        }
        entries.push({
          ...entry,
          storageKey: DIGEST_SHAPE.test(row.artifact_digest)
            ? storageKeyOf(entry)
            : `malformed:${row.artifact_key}`,
        });
      }
      return {
        entries: Object.freeze(entries),
        malformedDigests: Object.freeze(malformedDigests),
      };
    },

    async verifyLineagePreservation(
      inventory: readonly ArtifactInventoryEntry[],
    ): Promise<LineagePreservationReport> {
      const broken: string[] = [];
      for (const entry of inventory) {
        const result = await db.execute<{ readonly count: string }>({
          sql: `SELECT count(*) AS count
                FROM deployments.media_artifacts
                WHERE artifact_key = $1
                  AND application_id = $2
                  AND artifact_digest = $3
                  AND deployment_id = $4
                  AND job_id = $5
                  AND execution_id = $6
                  AND parent_digests = $7::jsonb`,
          parameters: [
            entry.artifactKey,
            entry.applicationId,
            entry.artifactDigest,
            entry.deploymentId,
            entry.jobId,
            entry.executionId,
            JSON.stringify(entry.parentDigests),
          ],
        });
        if (Number(result.rows[0]?.count ?? 0) !== 1) {
          broken.push(entry.artifactKey);
        }
      }
      return Object.freeze({
        entries: inventory.length,
        preserved: inventory.length - broken.length,
        broken: Object.freeze([...broken]),
        preservedAll: inventory.length > 0 && broken.length === 0,
      });
    },
  };
}

/**
 * The deployments module's recovered-state invariants (the adoption
 * ledger's digest shape and chain resolution).
 */
export function createArtifactLedgerRecoveryInvariants(db: DatabasePort): ModuleInvariantSource {
  return {
    module: "deployments",
    checks: [...ARTIFACT_LEDGER_RECOVERY_CHECKS],
    async verify(): Promise<readonly AuthorityInvariantViolation[]> {
      const violations: AuthorityInvariantViolation[] = [];

      const badDigests = await db.execute<{ readonly count: string }>({
        sql: "SELECT count(*) AS count FROM deployments.media_artifacts WHERE artifact_digest !~ '^[0-9a-f]{64}$'",
        parameters: [],
      });
      if (Number(badDigests.rows[0]?.count ?? 0) > 0) {
        violations.push({
          check: "artifact-adoption-digest-shape",
          detail: `${badDigests.rows[0]?.count} adoption rows with malformed digests`,
        });
      }

      const brokenChains = await db.execute<{ readonly count: string }>({
        sql: `SELECT count(*) AS count FROM deployments.media_artifacts a
              LEFT JOIN deployments.media_jobs j ON j.id = a.job_id
              LEFT JOIN deployments.deployments d ON d.id = a.deployment_id
              LEFT JOIN applications.applications app ON app.id = a.application_id AND app.tenant_id = a.tenant_id
              LEFT JOIN applications.tenants t ON t.id = a.tenant_id
              WHERE j.id IS NULL OR d.id IS NULL OR app.id IS NULL OR t.id IS NULL`,
        parameters: [],
      });
      if (Number(brokenChains.rows[0]?.count ?? 0) > 0) {
        violations.push({
          check: "artifact-adoption-chain-resolution",
          detail: `${brokenChains.rows[0]?.count} adoption rows with unresolvable job/deployment/application/tenant chains`,
        });
      }

      return violations;
    },
  };
}
