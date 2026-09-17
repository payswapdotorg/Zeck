/**
 * In-memory sandbox identity store (sandbox module adapter; DEP-014).
 *
 * The test double + in-memory composition. Rows key by identity id;
 * reset lineage (supersedes/supersededBy) is stored on the rows.
 */

import type { SandboxIdentityRecord } from "../domain/sandbox-identity";
import type {
  InsertSandboxIdentityInput,
  SandboxIdentityStore,
} from "../ports/sandbox-identity-store";

export function createInMemorySandboxIdentityStore(now: () => string): SandboxIdentityStore {
  const rows = new Map<string, SandboxIdentityRecord>();
  const snapshot = (record: SandboxIdentityRecord): SandboxIdentityRecord => ({ ...record });
  return {
    async insert(input: InsertSandboxIdentityInput) {
      const record: SandboxIdentityRecord = {
        id: input.id,
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        environmentId: input.environmentId,
        status: "active",
        createdAt: now(),
        expiresAt: input.expiresAt,
        supersededBy: null,
        supersedes: input.supersedes,
      };
      rows.set(record.id, record);
      return snapshot(record);
    },
    async find(applicationId, identityId) {
      const record = rows.get(identityId);
      if (record === undefined || record.applicationId !== applicationId) {
        return null;
      }
      return snapshot(record);
    },
    async list(applicationId) {
      return [...rows.values()]
        .filter((record) => record.applicationId === applicationId)
        .map(snapshot);
    },
    async transitionStatus(applicationId, identityId, status, supersededBy) {
      const record = rows.get(identityId);
      if (record === undefined || record.applicationId !== applicationId) {
        return null;
      }
      if (record.status === status && supersededBy === undefined) {
        return snapshot(record);
      }
      const next: SandboxIdentityRecord = {
        ...record,
        status,
        supersededBy: supersededBy ?? record.supersededBy,
      };
      rows.set(identityId, next);
      return snapshot(next);
    },
  };
}
