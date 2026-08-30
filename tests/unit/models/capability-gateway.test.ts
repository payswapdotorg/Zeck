/**
 * Unit: model gateway × capability authority integration (WORK-005 / INT-002
 * acceptance criterion 3) — the gateway consults the REAL registry (via the
 * registry-backed gate) before route selection; unsatisfied profiles deny
 * canonically; the frozen sequence is preserved for satisfied profiles.
 */

import { describe, expect, test } from "vitest";
import { createScopeResolver } from "../../../src/modules/auth/application/scope-resolver";
import type { Actor, Principal, ProvisionActorInput } from "../../../src/modules/auth/domain/actor";
import type { MembershipRecord } from "../../../src/modules/auth/domain/scope";
import type { IdentityStore } from "../../../src/modules/auth/public";
import {
  createCapabilityRegistry,
  createInMemoryCatalogStore,
  SEED_CAPABILITY_FACTS,
} from "../../../src/modules/capabilities/public";
import { createCapabilityGate } from "../../../src/modules/models/application/capability-gate";
import { createModelGateway } from "../../../src/modules/models/application/model-gateway";
import type { ModelRequest } from "../../../src/modules/models/domain/request";
import type { TaskCapabilityResolution } from "../../../src/modules/models/ports/capability-gate";
import type {
  DispatchJournal,
  JournalAttempt,
} from "../../../src/modules/models/ports/dispatch-journal";
import type { ModelProvider } from "../../../src/modules/models/ports/model-provider";
import { PlatformError } from "../../../src/shared/errors";

const TENANT = "tenant-cap";
const APP = "app-cap";
const PRINCIPAL: Principal = { actorId: "actor-cap", authenticatedAt: "2026-01-01T00:00:00Z" };

class FakeIdentity implements IdentityStore {
  async provisionActor(_: ProvisionActorInput & { id: string }): Promise<Actor> {
    throw new Error("unused");
  }
  async findActor(): Promise<Actor | null> {
    return null;
  }
  async findMembershipWithApplicationTenant(actorId: string, applicationId: string) {
    return {
      membership: {
        id: "m1",
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

function fixture(gate: TaskCapabilityResolution, options?: { readonly allow?: boolean }) {
  const allow = options?.allow ?? true;
  const order: string[] = [];
  const denials: string[] = [];
  const journal: DispatchJournal = {
    async recordIntent() {
      order.push("intent");
    },
    async recordOutcome() {
      order.push("outcome");
    },
    async recordDenial(_input, reason) {
      denials.push(reason);
      order.push("denial");
    },
    async findAttempt(): Promise<JournalAttempt | null> {
      return null;
    },
  };
  const provider: ModelProvider = {
    rail: "openrouter",
    async complete() {
      order.push("transport");
      return {
        kind: "provider-success",
        response: {
          content: ["ok"],
          stopReason: "stop",
          structuredOutput: null,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: null },
          providerLatencyMs: 1,
        },
      };
    },
    async *stream() {
      order.push("transport");
      yield {
        type: "stream-done",
        stopReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: null },
      };
    },
  };
  const gateway = createModelGateway({
    resolver: createScopeResolver(new FakeIdentity()),
    catalog: {
      async getConnectionForDispatch() {
        return {
          id: "conn",
          tenantId: TENANT,
          applicationId: APP,
          rail: "openrouter",
          endpointUrl: null,
          credentialKind: "byok",
          credentialRef: "vault-1",
          status: "active",
        };
      },
    },
    credentials: {
      async materialize() {
        order.push("materialize");
        return { reference: "vault-1", plaintext: "plain" };
      },
    },
    admission: {
      async admit() {
        order.push("admission");
        return allow ? { allowed: true } : { allowed: false, reason: "policy floor" };
      },
    },
    capabilities: gate,
    rails: {
      rails: ["openrouter"],
      providerFor: (rail) => {
        order.push(`rail:${rail}`);
        return provider;
      },
    },
    journal,
    generateId: () => "attempt-cap",
    hashRequest: () => "hash",
  });
  return { gateway, order, denials };
}

async function seededGate() {
  const registry = await createCapabilityRegistry({
    store: createInMemoryCatalogStore(),
    seed: SEED_CAPABILITY_FACTS,
  });
  return createCapabilityGate(registry);
}

const REQUEST: ModelRequest = {
  model: "m",
  messages: [{ role: "user", content: "u" }],
  taskProfile: { requirements: [{ id: "human-review", kind: "human" }] },
};

describe("model gateway × capability authority", () => {
  test("a satisfied profile dispatches with the frozen sequence preserved", async () => {
    const { gateway, order } = fixture(await seededGate());
    const result = await gateway.complete(PRINCIPAL, APP, "conn", REQUEST);
    expect(result.outcome.kind).toBe("provider-success");
    expect(order).toEqual([
      "admission",
      "rail:openrouter",
      "intent",
      "materialize",
      "transport",
      "outcome",
    ]);
  });

  test("an unsatisfiable profile fails CAPABILITY_UNAVAILABLE before rail resolution", async () => {
    const registry = await createCapabilityRegistry({ store: createInMemoryCatalogStore() });
    const { gateway, order, denials } = fixture(createCapabilityGate(registry));
    const error = await gateway.complete(PRINCIPAL, APP, "conn", REQUEST).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe("CAPABILITY_UNAVAILABLE");
    expect((error as PlatformError).details).toMatchObject({
      connectionId: "conn",
      catalogRevision: "rev-0",
    });
    expect(order).toEqual(["admission", "denial"]);
    expect(order.filter((step) => step.startsWith("rail"))).toHaveLength(0);
    expect(denials[0]?.startsWith("capability-unavailable: human-review")).toBe(true);
  });

  test("a version-floor the catalog cannot meet is denied even though the id exists", async () => {
    const { gateway, order } = fixture(await seededGate());
    const request: ModelRequest = {
      ...REQUEST,
      taskProfile: {
        requirements: [{ id: "text-generation", kind: "model", minVersion: "2.0.0" }],
      },
    };
    const error = await gateway.complete(PRINCIPAL, APP, "conn", request).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as PlatformError).code).toBe("CAPABILITY_UNAVAILABLE");
    expect(order).toEqual(["admission", "denial"]);
  });

  test("a request without a task profile resolves the empty profile and dispatches", async () => {
    const { gateway, order } = fixture(await seededGate());
    const result = await gateway.complete(PRINCIPAL, APP, "conn", {
      model: "m",
      messages: [{ role: "user", content: "u" }],
    });
    expect(result.outcome.kind).toBe("provider-success");
    expect(order).toContain("transport");
  });

  test("policy denial still wins: admission denies without consulting the capability gate", async () => {
    let gateConsulted = false;
    const gate: TaskCapabilityResolution = {
      async resolve() {
        gateConsulted = true;
        return { satisfied: true, catalogRevision: "rev-0", satisfactions: [] };
      },
    };
    const { gateway, order, denials } = fixture(gate, { allow: false });
    const error = await gateway.complete(PRINCIPAL, APP, "conn", REQUEST).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as PlatformError).code).toBe("POLICY_DENIED");
    expect(gateConsulted).toBe(false);
    expect(order).toEqual(["admission", "denial"]);
    expect(denials[0]).toBe("policy floor");
  });

  test("streaming enforces the identical capability boundary", async () => {
    const registry = await createCapabilityRegistry({ store: createInMemoryCatalogStore() });
    const { gateway, order } = fixture(createCapabilityGate(registry));
    const error = await gateway.stream(PRINCIPAL, APP, "conn", REQUEST).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as PlatformError).code).toBe("CAPABILITY_UNAVAILABLE");
    expect(order).toEqual(["admission", "denial"]);
    expect(order.filter((step) => step.startsWith("rail"))).toHaveLength(0);
  });
});
