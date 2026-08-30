/**
 * Secret-boundary probe: drives the REAL connection service over fakes and
 * captures every durable artifact it produces (outcomes, records, journal)
 * for the material-marker scan.
 */

import { createScopeResolver } from "../../../src/modules/auth/application/scope-resolver";
import type { Actor, Principal, ProvisionActorInput } from "../../../src/modules/auth/domain/actor";
import type { MembershipRecord } from "../../../src/modules/auth/domain/scope";
import type { IdentityStore } from "../../../src/modules/auth/public";
import { createConnectionService } from "../../../src/modules/connections/application/connection-service";
import type { StoredConnection } from "../../../src/modules/connections/domain/connection";
import type {
  ConnectionStore,
  InsertConnectionInput,
} from "../../../src/modules/connections/ports/connection-store";
import type { CredentialVault } from "../../../src/modules/connections/ports/credential-vault";
import type {
  ConnectionsIdempotencyPort,
  ConnectionTx,
  IdempotencyScope,
} from "../../../src/modules/connections/ports/idempotency";

const TENANT = "tenant-probe";
const APP = "app-probe";
const PRINCIPAL: Principal = { actorId: "actor-probe", authenticatedAt: "2026-01-01T00:00:00Z" };

class ProbeIdentity implements IdentityStore {
  async provisionActor(_: ProvisionActorInput & { id: string }): Promise<Actor> {
    throw new Error("unused");
  }
  async findActor(): Promise<Actor | null> {
    return null;
  }
  async findMembershipWithApplicationTenant(actorId: string, applicationId: string) {
    return {
      membership: {
        id: "m",
        actorId,
        applicationId,
        tenantId: TENANT,
        role: "owner",
        createdAt: "2026-01-01T00:00:00Z",
      } satisfies MembershipRecord,
      applicationTenantId: TENANT,
    };
  }
  async findTenantMembership(): Promise<MembershipRecord | null> {
    return null;
  }
  async listMemberships(): Promise<readonly MembershipRecord[]> {
    return [];
  }
  async insertMembership(): Promise<MembershipRecord | null> {
    return null;
  }
  async updateMembershipRole(): Promise<MembershipRecord | null> {
    return null;
  }
  async deleteMembership(): Promise<boolean> {
    return false;
  }
  async lockApplicationMemberships(): Promise<readonly MembershipRecord[]> {
    return [];
  }
}

export function buildSecretProbe() {
  const MATERIAL_MARKER = "sk-SECRET-ORIGINAL-9f1a";
  const ROTATION_MARKER = "sk-SECRET-ROTATED-77ce";

  const rows = new Map<string, StoredConnection>();
  const outcomes: unknown[] = [];

  const store: ConnectionStore = {
    async insertConnection(input: InsertConnectionInput) {
      for (const row of rows.values()) {
        if (row.applicationId === input.applicationId && row.label === input.label) {
          return null;
        }
      }
      const row: StoredConnection = {
        id: input.id,
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        rail: input.rail,
        label: input.label,
        endpointUrl: input.endpointUrl,
        credentialKind: input.credentialKind,
        credentialRef: input.credentialRef,
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      rows.set(row.id, row);
      return row;
    },
    async findConnection(id) {
      return rows.get(id) ?? null;
    },
    async findConnectionByLabel(_a, _t, label) {
      for (const row of rows.values()) {
        if (row.label === label) return row;
      }
      return null;
    },
    async findDispatchFacts(id) {
      const row = rows.get(id);
      return row === undefined
        ? null
        : {
            id: row.id,
            tenantId: row.tenantId,
            applicationId: row.applicationId,
            rail: row.rail,
            endpointUrl: row.endpointUrl,
            credentialKind: row.credentialKind,
            credentialRef: row.credentialRef,
            status: row.status,
          };
    },
    async listConnectionsByApplication(applicationId) {
      return [...rows.values()].filter((row) => row.applicationId === applicationId);
    },
    async lockConnection(id) {
      return rows.get(id) ?? null;
    },
    async updateStatus(id, status) {
      const row = rows.get(id);
      if (row === undefined) return null;
      const updated = { ...row, status };
      rows.set(id, updated);
      return updated;
    },
    async updateCredentialRef(id, credentialRef) {
      const row = rows.get(id);
      if (row === undefined) return null;
      const updated = { ...row, credentialRef };
      rows.set(id, updated);
      return updated;
    },
    async deleteConnection(id) {
      return rows.delete(id);
    },
  };

  const vault: CredentialVault = {
    async store(material) {
      return { reference: `vault:${material.slice(-6)}` };
    },
    async materialize(reference) {
      return { reference, plaintext: "should-not-be-serialized" };
    },
    async destroy() {
      return true;
    },
  };

  const ledger: ConnectionsIdempotencyPort = {
    async arbitrate<T>(
      scope: IdempotencyScope,
      operationName: string,
      idempotencyKey: string,
      requestFingerprint: string,
      work: (tx: ConnectionTx) => Promise<T>,
    ) {
      void scope;
      void operationName;
      void idempotencyKey;
      void requestFingerprint;
      const outcome = await work({ store, vault });
      outcomes.push(outcome);
      return { outcome, replayed: false };
    },
  };

  const identity = new ProbeIdentity();
  let seq = 0;
  const service = createConnectionService(
    store,
    ledger,
    createScopeResolver(identity),
    identity,
    () => {
      seq += 1;
      return `probe-${seq}`;
    },
    { digestMaterial: async () => "digest" },
  );

  let connectionId = "";

  return {
    MATERIAL_MARKER,
    ROTATION_MARKER,
    async register() {
      const { connection } = await service.registerConnection(
        {
          principal: PRINCIPAL,
          applicationId: APP,
          rail: "openrouter",
          label: "probe-connection",
          registerCredential: { material: MATERIAL_MARKER },
        },
        "probe-key-1",
      );
      connectionId = connection.id;
    },
    async rotate() {
      await service.rotateCredential(
        { principal: PRINCIPAL, applicationId: APP, connectionId, material: ROTATION_MARKER },
        "probe-key-2",
      );
    },
    async list() {
      await service.listConnections(PRINCIPAL, APP);
    },
    serializedEverything(): string {
      return JSON.stringify({ outcomes, rows: [...rows.values()], vaultJournal: "empty" });
    },
  };
}
