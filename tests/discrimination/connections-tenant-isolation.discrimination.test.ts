/**
 * Discrimination: connections tenant isolation (WORK-003).
 *
 * The WORK-002 discipline extended to connections: a journaled store proves
 * NO downstream writes happen when a cross-tenant target is rejected, and
 * list reads never surface foreign-tenant rows.
 */

import { describe, expect, test } from "vitest";
import { createScopeResolver } from "../../src/modules/auth/application/scope-resolver";
import type { Actor, Principal, ProvisionActorInput } from "../../src/modules/auth/domain/actor";
import type { MembershipRecord } from "../../src/modules/auth/domain/scope";
import type { IdentityStore } from "../../src/modules/auth/public";
import { createConnectionService } from "../../src/modules/connections/application/connection-service";
import type { StoredConnection } from "../../src/modules/connections/domain/connection";
import type {
  ConnectionStore,
  InsertConnectionInput,
} from "../../src/modules/connections/ports/connection-store";
import type { CredentialVault } from "../../src/modules/connections/ports/credential-vault";
import type {
  ConnectionsIdempotencyPort,
  ConnectionTx,
  IdempotencyScope,
} from "../../src/modules/connections/ports/idempotency";
import { PlatformError } from "../../src/shared/errors";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const APP_A = "app-a";
const APP_B = "app-b";
const IN_APP_A: Principal = { actorId: "actor-a", authenticatedAt: "2026-01-01T00:00:00Z" };

class TwoTenantIdentity implements IdentityStore {
  async provisionActor(_: ProvisionActorInput & { id: string }): Promise<Actor> {
    throw new Error("unused");
  }
  async findActor(): Promise<Actor | null> {
    return null;
  }
  async findMembershipWithApplicationTenant(actorId: string, applicationId: string) {
    if (actorId !== "actor-a" || applicationId !== APP_A) {
      return null;
    }
    return {
      membership: {
        id: "m",
        actorId,
        applicationId: APP_A,
        tenantId: TENANT_A,
        role: "owner",
        createdAt: "2026-01-01T00:00:00Z",
      } satisfies MembershipRecord,
      applicationTenantId: TENANT_A,
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

/** Journaled store: every WRITE is recorded so rejections provably write nothing. */
class JournaledStore implements ConnectionStore {
  rows = new Map<string, StoredConnection>();
  writes: string[] = [];
  async insertConnection(input: InsertConnectionInput) {
    this.writes.push(`insert:${input.label}`);
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
    this.rows.set(row.id, row);
    return row;
  }
  async findConnection(id: string) {
    return this.rows.get(id) ?? null;
  }
  async findConnectionByLabel(_a: string, _t: string, label: string) {
    for (const row of this.rows.values()) {
      if (row.label === label) return row;
    }
    return null;
  }
  async findDispatchFacts(id: string) {
    const row = this.rows.get(id);
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
  }
  async listConnectionsByApplication(applicationId: string, tenantId: string) {
    return [...rowsOf(this)].filter(
      (row) =>
        row.applicationId === applicationId && (tenantId === "" || row.tenantId === tenantId),
    );
    function rowsOf(self: JournaledStore): StoredConnection[] {
      return [...self.rows.values()];
    }
  }
  async lockConnection(id: string) {
    return this.rows.get(id) ?? null;
  }
  async updateStatus(id: string, status: "active" | "disabled") {
    this.writes.push(`updateStatus:${id}`);
    const row = this.rows.get(id);
    if (row === undefined) return null;
    const updated = { ...row, status };
    this.rows.set(id, updated);
    return updated;
  }
  async updateCredentialRef(id: string, credentialRef: string) {
    this.writes.push(`updateCredentialRef:${id}`);
    const row = this.rows.get(id);
    if (row === undefined) return null;
    const updated = { ...row, credentialRef };
    this.rows.set(id, updated);
    return updated;
  }
  async deleteConnection(id: string) {
    this.writes.push(`delete:${id}`);
    return this.rows.delete(id);
  }
}

function build() {
  const store = new JournaledStore();
  const vault: CredentialVault = {
    async store() {
      return { reference: "vault-x" };
    },
    async materialize() {
      return { reference: "vault-x", plaintext: "p" };
    },
    async destroy() {
      return true;
    },
  };
  const ledger: ConnectionsIdempotencyPort = {
    async arbitrate<T>(
      _scope: IdempotencyScope,
      _op: string,
      _key: string,
      _fp: string,
      work: (tx: ConnectionTx) => Promise<T>,
    ) {
      const outcome = await work({ store, vault });
      return { outcome, replayed: false };
    },
  };
  const identity = new TwoTenantIdentity();
  let seq = 0;
  const service = createConnectionService(
    store,
    ledger,
    createScopeResolver(identity),
    identity,
    () => {
      seq += 1;
      return `iso-${seq}`;
    },
    { digestMaterial: async () => "d" },
  );
  return { store, vault, service };
}

describe("discrimination: connections tenant isolation", () => {
  test("actor of tenant A cannot act on tenant B's connection: rejected, zero writes", async () => {
    const { store, service } = build();
    // Seed a foreign-tenant connection directly (durable state).
    await store.insertConnection({
      id: "foreign",
      applicationId: APP_B,
      tenantId: TENANT_B,
      rail: "openrouter",
      label: "foreign-connection",
      endpointUrl: null,
      credentialKind: "platform",
      credentialRef: null,
    });
    const writesBefore = [...store.writes];

    const mutations = [
      () =>
        service.updateStatus(
          {
            principal: IN_APP_A,
            applicationId: APP_A,
            connectionId: "foreign",
            status: "disabled",
          },
          "k1",
        ),
      () =>
        service.rotateCredential(
          { principal: IN_APP_A, applicationId: APP_A, connectionId: "foreign", material: "x" },
          "k2",
        ),
      () =>
        service.removeConnection(
          { principal: IN_APP_A, applicationId: APP_A, connectionId: "foreign" },
          "k3",
        ),
    ];
    for (const mutation of mutations) {
      const error = await mutation().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(PlatformError);
      const code = (error as PlatformError).code;
      expect(["TENANT_SCOPE_VIOLATION", "AUTHORIZATION_DENIED"]).toContain(code);
    }
    // ZERO downstream writes beyond the seed: the foreign row survives.
    expect(store.writes.filter((w) => !w.startsWith("insert:"))).toEqual([]);
    expect(writesBefore.length).toBe(store.writes.length);
    expect(store.rows.get("foreign")).toBeDefined();

    // Dispatch facts are equally guarded.
    const factsError = await service
      .getConnectionForDispatch({ tenantId: TENANT_A, applicationId: APP_A }, "foreign")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((factsError as PlatformError).code).toBe("TENANT_SCOPE_VIOLATION");
  });

  test("list reads never surface foreign-tenant rows", async () => {
    const { store, service } = build();
    await store.insertConnection({
      id: "mine",
      applicationId: APP_A,
      tenantId: TENANT_A,
      rail: "openrouter",
      label: "mine",
      endpointUrl: null,
      credentialKind: "platform",
      credentialRef: null,
    });
    await store.insertConnection({
      id: "theirs",
      applicationId: APP_B,
      tenantId: TENANT_B,
      rail: "openrouter",
      label: "theirs",
      endpointUrl: null,
      credentialKind: "platform",
      credentialRef: null,
    });
    const listed = await service.listConnections(IN_APP_A, APP_A);
    expect(listed.map((row) => row.id)).toEqual(["mine"]);
  });

  test("actors with no membership for the application are denied before any write", async () => {
    const { store, service } = build();
    const outsider: Principal = { actorId: "actor-b", authenticatedAt: "2026-01-01T00:00:00Z" };
    const error = await service
      .registerConnection(
        { principal: outsider, applicationId: APP_A, rail: "openrouter", label: "nope" },
        "k",
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((error as PlatformError).code).toBe("AUTHORIZATION_DENIED");
    expect(store.writes).toEqual([]);
  });
});
