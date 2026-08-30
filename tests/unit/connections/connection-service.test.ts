/**
 * Unit: connection service (connections module, WORK-003).
 *
 * Fakes implement the module ports; the scope resolver is the REAL auth
 * application service over an in-memory identity store, so the server-derived
 * scope discipline is exercised on every command.
 */

import { describe, expect, test } from "vitest";
import { createScopeResolver } from "../../../src/modules/auth/application/scope-resolver";
import type { Actor, Principal, ProvisionActorInput } from "../../../src/modules/auth/domain/actor";
import type { ApplicationRole } from "../../../src/modules/auth/domain/roles";
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
import { PlatformError } from "../../../src/shared/errors";

const TENANT_A = "tenant-a";
const APP_1 = "app-1";
const OWNER: Principal = { actorId: "actor-owner", authenticatedAt: "2026-01-01T00:00:00.000Z" };
const MEMBER: Principal = { actorId: "actor-member", authenticatedAt: "2026-01-01T00:00:00.000Z" };

class FakeIdentityStore implements IdentityStore {
  constructor(private readonly memberships: Map<string, MembershipRecord>) {}
  async provisionActor(_: ProvisionActorInput & { id: string }): Promise<Actor> {
    throw new Error("not used");
  }
  async findActor(): Promise<Actor | null> {
    return null;
  }
  async findMembershipWithApplicationTenant(actorId: string, applicationId: string) {
    const membership = this.memberships.get(`${actorId}:${applicationId}`);
    return membership === undefined
      ? null
      : { membership, applicationTenantId: membership.tenantId };
  }
  async findTenantMembership(): Promise<MembershipRecord | null> {
    return null;
  }
  async listMemberships(): Promise<readonly MembershipRecord[]> {
    return [...this.memberships.values()];
  }
  async insertMembership(): Promise<MembershipRecord | null> {
    throw new Error("not used");
  }
  async updateMembershipRole(): Promise<MembershipRecord | null> {
    return null;
  }
  async deleteMembership(): Promise<boolean> {
    return false;
  }
  async lockApplicationMemberships(): Promise<readonly MembershipRecord[]> {
    return this.listMemberships();
  }
}

function membershipOf(
  actorId: string,
  role: ApplicationRole,
  applicationId: string = APP_1,
): MembershipRecord {
  return {
    id: `membership-${actorId}`,
    actorId,
    applicationId,
    tenantId: TENANT_A,
    role,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

class FakeStore implements ConnectionStore {
  rows = new Map<string, StoredConnection>();
  inserts = 0;
  deletes = 0;
  async insertConnection(input: InsertConnectionInput): Promise<StoredConnection | null> {
    for (const row of this.rows.values()) {
      if (
        row.applicationId === input.applicationId &&
        row.tenantId === input.tenantId &&
        row.label === input.label
      ) {
        return null;
      }
    }
    this.inserts += 1;
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
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    this.rows.set(row.id, row);
    return row;
  }
  async findConnection(id: string): Promise<StoredConnection | null> {
    return this.rows.get(id) ?? null;
  }
  async findConnectionByLabel(applicationId: string, _tenantId: string, label: string) {
    for (const row of this.rows.values()) {
      if (row.applicationId === applicationId && row.label === label) {
        return row;
      }
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
    return [...this.rows.values()].filter(
      (row) =>
        row.applicationId === applicationId && (tenantId === "" || row.tenantId === tenantId),
    );
  }
  async lockConnection(id: string): Promise<StoredConnection | null> {
    return this.rows.get(id) ?? null;
  }
  async updateStatus(id: string, status: "active" | "disabled") {
    const row = this.rows.get(id);
    if (row === undefined) return null;
    const updated = { ...row, status };
    this.rows.set(id, updated);
    return updated;
  }
  async updateCredentialRef(id: string, credentialRef: string) {
    const row = this.rows.get(id);
    if (row === undefined) return null;
    const updated = { ...row, credentialRef };
    this.rows.set(id, updated);
    return updated;
  }
  async deleteConnection(id: string): Promise<boolean> {
    this.deletes += 1;
    return this.rows.delete(id);
  }
}

class FakeVault implements CredentialVault {
  material = new Map<string, string>();
  stores = 0;
  destroys = 0;
  materializations: string[] = [];
  private seq = 0;
  async store(material: string): Promise<{ reference: string }> {
    this.stores += 1;
    this.seq += 1;
    const reference = `vault-${this.seq}`;
    this.material.set(reference, material);
    return { reference };
  }
  async materialize(reference: string) {
    this.materializations.push(reference);
    const plaintext = this.material.get(reference);
    if (plaintext === undefined) {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message: "credential reference not found",
      });
    }
    return { reference, plaintext };
  }
  async destroy(reference: string): Promise<boolean> {
    this.destroys += 1;
    return this.material.delete(reference);
  }
}

class FakeLedger implements ConnectionsIdempotencyPort {
  private records = new Map<string, { fingerprint: string; outcome: unknown }>();
  executions = 0;
  async arbitrate<T>(
    scope: IdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (tx: ConnectionTx) => Promise<T>,
  ): Promise<{ outcome: T; replayed: boolean }> {
    const key = `${scope.applicationId}:${operationName}:${idempotencyKey}`;
    const existing = this.records.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "idempotency key was already used with a different request fingerprint",
        });
      }
      return { outcome: existing.outcome as T, replayed: true };
    }
    this.executions += 1;
    const outcome = await work({ store: store, vault });
    this.records.set(key, { fingerprint: requestFingerprint, outcome });
    return { outcome, replayed: false };
  }
}

function expectError(code: string, fn: () => Promise<unknown>): Promise<void> {
  return fn().then(
    () => expect.unreachable(`expected ${code}`),
    (error: unknown) => {
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe(code);
    },
  );
}

function buildService(
  roles: Array<{ actorId: string; role: ApplicationRole }> = [
    { actorId: OWNER.actorId, role: "owner" },
    { actorId: MEMBER.actorId, role: "member" },
  ],
) {
  const memberships = new Map<string, MembershipRecord>();
  for (const { actorId, role } of roles) {
    memberships.set(`${actorId}:${APP_1}`, membershipOf(actorId, role));
  }
  const identity = new FakeIdentityStore(memberships);
  const resolver = createScopeResolver(identity);
  const service = createConnectionService(
    store,
    ledger,
    resolver,
    identity,
    () => {
      seq += 1;
      return `id-${seq}`;
    },
    { digestMaterial: async (m) => `digest:${m.length}` },
  );
  return { service };
}

let store: FakeStore;
let vault: FakeVault;
let ledger: FakeLedger;
let seq = 0;

describe("connection service", () => {
  test("registerConnection persists BYOK as a vault reference and returns a ref-free record", async () => {
    store = new FakeStore();
    vault = new FakeVault();
    ledger = new FakeLedger();
    seq = 0;
    const { service } = buildService();

    const { connection } = await service.registerConnection(
      {
        principal: OWNER,
        applicationId: APP_1,
        rail: "openrouter",
        label: "primary-openrouter",
        registerCredential: { material: "sk-or-v1-abc123" },
      },
      "key-1",
    );

    expect(connection.rail).toBe("openrouter");
    expect(connection.credentialKind).toBe("byok");
    expect(connection.tenantId).toBe(TENANT_A);
    // Public record carries NO credential material of any kind.
    expect(JSON.stringify(connection)).not.toContain("credentialRef");
    expect(JSON.stringify(connection)).not.toContain("sk-or-v1-abc123");
    expect(vault.stores).toBe(1);
    const stored = store.rows.get(connection.id);
    expect(stored?.credentialRef).toMatch(/^vault-/);
  });

  test("registerConnection without material registers a platform connection", async () => {
    store = new FakeStore();
    vault = new FakeVault();
    ledger = new FakeLedger();
    seq = 0;
    const { service } = buildService();

    const { connection } = await service.registerConnection(
      { principal: OWNER, applicationId: APP_1, rail: "anthropic", label: "direct-anthropic" },
      "key-1",
    );
    expect(connection.credentialKind).toBe("platform");
    expect(vault.stores).toBe(0);
  });

  test("registerConnection validates rail, label and endpoint rules", async () => {
    store = new FakeStore();
    vault = new FakeVault();
    ledger = new FakeLedger();
    seq = 0;
    const { service } = buildService();

    await expectError("AUTHORIZATION_DENIED", () =>
      service.registerConnection(
        { principal: OWNER, applicationId: APP_1, rail: "openai" as "openrouter", label: "x" },
        "k",
      ),
    );
    await expectError("AUTHORIZATION_DENIED", () =>
      service.registerConnection(
        { principal: OWNER, applicationId: APP_1, rail: "openrouter", label: "Bad Label" },
        "k",
      ),
    );
    await expectError("AUTHORIZATION_DENIED", () =>
      service.registerConnection(
        { principal: OWNER, applicationId: APP_1, rail: "custom", label: "custom-endpoint" },
        "k",
      ),
    );
  });

  test("write permission is required (member role denied)", async () => {
    store = new FakeStore();
    vault = new FakeVault();
    ledger = new FakeLedger();
    seq = 0;
    const { service } = buildService();

    await expectError("AUTHORIZATION_DENIED", () =>
      service.registerConnection(
        { principal: MEMBER, applicationId: APP_1, rail: "openrouter", label: "members-cannot" },
        "k",
      ),
    );
    // Reads are allowed for members.
    const listed = await service.listConnections(MEMBER, APP_1);
    expect(listed).toEqual([]);
  });

  test("identical retry replays the durable outcome without re-storing material", async () => {
    store = new FakeStore();
    vault = new FakeVault();
    ledger = new FakeLedger();
    seq = 0;
    const { service } = buildService();

    const first = await service.registerConnection(
      {
        principal: OWNER,
        applicationId: APP_1,
        rail: "openrouter",
        label: "primary",
        registerCredential: { material: "sk-or-v1-first" },
      },
      "same-key",
    );
    const second = await service.registerConnection(
      {
        principal: OWNER,
        applicationId: APP_1,
        rail: "openrouter",
        label: "primary",
        registerCredential: { material: "sk-or-v1-first" },
      },
      "same-key",
    );
    expect(second.connection.id).toBe(first.connection.id);
    expect(vault.stores).toBe(1);
    expect(ledger.executions).toBe(1);
  });

  test("same key with different material is rejected as key reuse", async () => {
    store = new FakeStore();
    vault = new FakeVault();
    ledger = new FakeLedger();
    seq = 0;
    const { service } = buildService();

    await service.registerConnection(
      {
        principal: OWNER,
        applicationId: APP_1,
        rail: "openrouter",
        label: "primary",
        registerCredential: { material: "sk-or-v1-first" },
      },
      "same-key",
    );
    await expectError("IDEMPOTENCY_KEY_REUSED", () =>
      service.registerConnection(
        {
          principal: OWNER,
          applicationId: APP_1,
          rail: "openrouter",
          label: "primary",
          registerCredential: { material: "sk-or-v1-SECOND" },
        },
        "same-key",
      ),
    );
  });

  test("updateStatus converges on same status and rejects foreign connections", async () => {
    store = new FakeStore();
    vault = new FakeVault();
    ledger = new FakeLedger();
    seq = 0;
    const { service } = buildService();

    const { connection } = await service.registerConnection(
      { principal: OWNER, applicationId: APP_1, rail: "openrouter", label: "primary" },
      "k1",
    );
    const disabled = await service.updateStatus(
      { principal: OWNER, applicationId: APP_1, connectionId: connection.id, status: "disabled" },
      "k2",
    );
    expect(disabled.changed).toBe(true);
    const again = await service.updateStatus(
      { principal: OWNER, applicationId: APP_1, connectionId: connection.id, status: "disabled" },
      "k3",
    );
    expect(again.changed).toBe(false);

    // A connection of a different application (same tenant) is rejected.
    store.rows.set("foreign", {
      ...connection,
      id: "foreign",
      applicationId: "app-2",
      label: "foreign",
      credentialRef: null,
    });
    await expectError("TENANT_SCOPE_VIOLATION", () =>
      service.updateStatus(
        { principal: OWNER, applicationId: APP_1, connectionId: "foreign", status: "active" },
        "k4",
      ),
    );
  });

  test("rotateCredential swaps the reference and destroys superseded material", async () => {
    store = new FakeStore();
    vault = new FakeVault();
    ledger = new FakeLedger();
    seq = 0;
    const { service } = buildService();

    const { connection } = await service.registerConnection(
      {
        principal: OWNER,
        applicationId: APP_1,
        rail: "openrouter",
        label: "primary",
        registerCredential: { material: "old-material" },
      },
      "k1",
    );
    const oldRef = store.rows.get(connection.id)?.credentialRef ?? "";
    const rotated = await service.rotateCredential(
      {
        principal: OWNER,
        applicationId: APP_1,
        connectionId: connection.id,
        material: "new-material",
      },
      "k2",
    );
    expect(JSON.stringify(rotated.connection)).not.toContain("new-material");
    expect(vault.material.has(oldRef)).toBe(false);
    expect(vault.destroys).toBe(1);
    const newRef = store.rows.get(connection.id)?.credentialRef ?? "";
    expect(newRef).not.toBe(oldRef);
    expect(vault.material.get(newRef)).toBe("new-material");
  });

  test("removeConnection destroys the credential and converges on retry", async () => {
    store = new FakeStore();
    vault = new FakeVault();
    ledger = new FakeLedger();
    seq = 0;
    const { service } = buildService();

    const { connection } = await service.registerConnection(
      {
        principal: OWNER,
        applicationId: APP_1,
        rail: "anthropic",
        label: "direct",
        registerCredential: { material: "material" },
      },
      "k1",
    );
    const ref = store.rows.get(connection.id)?.credentialRef ?? "";
    const removed = await service.removeConnection(
      { principal: OWNER, applicationId: APP_1, connectionId: connection.id },
      "k2",
    );
    expect(removed.removed).toBe(true);
    expect(vault.material.has(ref)).toBe(false);
    const retry = await service.removeConnection(
      { principal: OWNER, applicationId: APP_1, connectionId: connection.id },
      "k3",
    );
    expect(retry.removed).toBe(false);
  });

  test("getConnectionForDispatch enforces tenant, application and status", async () => {
    store = new FakeStore();
    vault = new FakeVault();
    ledger = new FakeLedger();
    seq = 0;
    const { service } = buildService();

    const { connection } = await service.registerConnection(
      { principal: OWNER, applicationId: APP_1, rail: "openrouter", label: "primary" },
      "k1",
    );
    const facts = await service.getConnectionForDispatch(
      { tenantId: TENANT_A, applicationId: APP_1 },
      connection.id,
    );
    expect(facts.rail).toBe("openrouter");

    await expectError("TENANT_SCOPE_VIOLATION", () =>
      service.getConnectionForDispatch(
        { tenantId: "tenant-b", applicationId: APP_1 },
        connection.id,
      ),
    );
    await expectError("TENANT_SCOPE_VIOLATION", () =>
      service.getConnectionForDispatch(
        { tenantId: TENANT_A, applicationId: "app-9" },
        connection.id,
      ),
    );
    await expectError("AUTHORIZATION_DENIED", () =>
      service.getConnectionForDispatch({ tenantId: TENANT_A, applicationId: APP_1 }, "missing"),
    );

    await service.updateStatus(
      { principal: OWNER, applicationId: APP_1, connectionId: connection.id, status: "disabled" },
      "k2",
    );
    await expectError("AUTHORIZATION_DENIED", () =>
      service.getConnectionForDispatch({ tenantId: TENANT_A, applicationId: APP_1 }, connection.id),
    );
  });

  test("label collision converges only on identical configuration", async () => {
    store = new FakeStore();
    vault = new FakeVault();
    ledger = new FakeLedger();
    seq = 0;
    const { service } = buildService();

    await service.registerConnection(
      { principal: OWNER, applicationId: APP_1, rail: "openrouter", label: "primary" },
      "k1",
    );
    // Identical shape under a DIFFERENT key converges to the existing row.
    const converged = await service.registerConnection(
      { principal: OWNER, applicationId: APP_1, rail: "openrouter", label: "primary" },
      "k2",
    );
    expect(converged.connection.label).toBe("primary");
    // Conflicting configuration is rejected.
    await expectError("AUTHORIZATION_DENIED", () =>
      service.registerConnection(
        { principal: OWNER, applicationId: APP_1, rail: "anthropic", label: "primary" },
        "k3",
      ),
    );
  });
});
