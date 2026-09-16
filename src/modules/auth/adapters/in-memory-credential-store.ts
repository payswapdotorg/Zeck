/**
 * In-memory credential store (auth module test double; DEP-011).
 *
 * The same durable contract as the SQL adapter (migration 0033): one ACTIVE
 * record per credential identity (a second active insert under the same
 * identity fails), retirement/revoke transitions are state-exact, and
 * lookups carry the tenant facts the service's scope guard consumes.
 * Sequential by construction (the unit-test substrate); the SQL adapter is
 * the concurrency-authoritative implementation.
 */

import type { CredentialStatus } from "../domain/credential";
import type {
  CredentialStore,
  CredentialStoreRow,
  InsertCredentialInput,
  ListCredentialsFilter,
  RetireCredentialInput,
} from "../ports/credential-store";
import { toCredentialRecord } from "../ports/credential-store";

export class InMemoryCredentialStore implements CredentialStore {
  private readonly rows = new Map<string, CredentialStoreRow>();

  async insertCredential(input: InsertCredentialInput): Promise<CredentialStoreRow> {
    const active = this.findByCredentialId(input.credentialId).find(
      (row) => row.status === "active",
    );
    if (active !== undefined) {
      throw new Error(
        `in-memory credential store: identity ${input.credentialId} already has an active record`,
      );
    }
    const row: CredentialStoreRow = {
      id: input.id,
      credentialId: input.credentialId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      label: input.label,
      role: input.role,
      status: "active",
      createdAt: new Date().toISOString(),
      rotatedAt: null,
      supersededBy: null,
      secretReference: input.secretReference,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async findCurrentByCredentialId(credentialId: string): Promise<CredentialStoreRow | null> {
    const lineage = this.findByCredentialId(credentialId);
    if (lineage.length === 0) {
      return null;
    }
    const active = lineage.find((row) => row.status === "active");
    if (active !== undefined) {
      return active;
    }
    // Newest first: the convergence view for idempotent revocation.
    return lineage[0] ?? null;
  }

  async listCredentialLineage(credentialId: string): Promise<readonly CredentialStoreRow[]> {
    return this.findByCredentialId(credentialId);
  }

  async listCredentials(filter: ListCredentialsFilter): Promise<readonly CredentialStoreRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.applicationId === filter.applicationId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async retireCredential(
    recordId: string,
    input: RetireCredentialInput,
  ): Promise<CredentialStoreRow | null> {
    const row = this.rows.get(recordId);
    if (row === undefined) {
      return null;
    }
    const updated: CredentialStoreRow = {
      ...row,
      status: "retired",
      rotatedAt: input.rotatedAt,
      supersededBy: input.supersededBy,
    };
    this.rows.set(recordId, updated);
    return updated;
  }

  async revokeCredential(recordId: string): Promise<CredentialStoreRow | null> {
    const row = this.rows.get(recordId);
    if (row === undefined) {
      return null;
    }
    if (row.status === "revoked") {
      // Idempotent convergence (the same contract as the SQL adapter).
      return row;
    }
    const updated: CredentialStoreRow = { ...row, status: "revoked" };
    this.rows.set(recordId, updated);
    return updated;
  }

  /** Test introspection: the metadata-only records (never the secret handles). */
  records(): readonly ReturnType<typeof toCredentialRecord>[] {
    return [...this.rows.values()].map((row) => toCredentialRecord(row));
  }

  /** Test introspection: the raw statuses by row id. */
  statuses(): Readonly<Record<string, CredentialStatus>> {
    const out: Record<string, CredentialStatus> = {};
    for (const [id, row] of this.rows) {
      out[id] = row.status;
    }
    return out;
  }

  private findByCredentialId(credentialId: string): CredentialStoreRow[] {
    return [...this.rows.values()]
      .filter((row) => row.credentialId === credentialId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .reverse();
  }
}
