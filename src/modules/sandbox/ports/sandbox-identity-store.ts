/**
 * Sandbox identity store port (sandbox module outbound; DEP-014).
 *
 * Implemented by SQL and in-memory adapters. Rows key by identity id;
 * the lineage columns (supersedes/supersededBy) make reset auditable.
 */

import type { SandboxIdentityRecord } from "../domain/sandbox-identity";

export interface InsertSandboxIdentityInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly environmentId: string | null;
  readonly expiresAt: string;
  readonly supersedes: string | null;
}

export interface SandboxIdentityStore {
  insert(input: InsertSandboxIdentityInput): Promise<SandboxIdentityRecord>;
  find(applicationId: string, identityId: string): Promise<SandboxIdentityRecord | null>;
  list(applicationId: string): Promise<readonly SandboxIdentityRecord[]>;
  /** Transition a status (idempotent: same-status is a no-op success). */
  transitionStatus(
    applicationId: string,
    identityId: string,
    status: SandboxIdentityRecord["status"],
    supersededBy?: string,
  ): Promise<SandboxIdentityRecord | null>;
}
