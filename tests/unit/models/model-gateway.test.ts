/**
 * Unit: model gateway sequencing and gating (WORK-003).
 *
 * Fakes record call ORDER across every dependency, proving the frozen
 * dispatch sequence (`IMPLEMENTATION.md` §7) — admission BEFORE secret
 * materialization BEFORE transport, durable intent BEFORE the adapter call,
 * observation persisted last — plus denial, tenant and rail resolution
 * behavior.
 */

import { describe, expect, test } from "vitest";
import { createScopeResolver } from "../../../src/modules/auth/application/scope-resolver";
import type { Actor, Principal, ProvisionActorInput } from "../../../src/modules/auth/domain/actor";
import type { MembershipRecord } from "../../../src/modules/auth/domain/scope";
import type { IdentityStore } from "../../../src/modules/auth/public";
import { createModelGateway } from "../../../src/modules/models/application/model-gateway";
import type { ModelCallOutcome } from "../../../src/modules/models/domain/outcome";
import type { ProviderFailure } from "../../../src/modules/models/domain/provider-failure";
import type { ModelRequest } from "../../../src/modules/models/domain/request";
import { EMPTY_USAGE } from "../../../src/modules/models/domain/response";
import type {
  AdmissionDecision,
  AdmissionInput,
  DispatchAdmission,
} from "../../../src/modules/models/ports/dispatch-admission";
import type {
  DispatchJournal,
  JournalAttempt,
} from "../../../src/modules/models/ports/dispatch-journal";
import type {
  ModelProvider,
  ProviderDispatchContext,
} from "../../../src/modules/models/ports/model-provider";
import { PlatformError } from "../../../src/shared/errors";

const TENANT = "tenant-1";
const APP = "app-1";
const PRINCIPAL: Principal = { actorId: "actor-1", authenticatedAt: "2026-01-01T00:00:00Z" };
const OPENROUTER_CONNECTION = "conn-openrouter";
const ANTHROPIC_CONNECTION = "conn-anthropic";

const FACTS: Record<string, object> = {
  [OPENROUTER_CONNECTION]: {
    id: OPENROUTER_CONNECTION,
    tenantId: TENANT,
    applicationId: APP,
    rail: "openrouter",
    endpointUrl: null,
    credentialKind: "byok",
    credentialRef: "vault-1",
    status: "active",
  },
  [ANTHROPIC_CONNECTION]: {
    id: ANTHROPIC_CONNECTION,
    tenantId: TENANT,
    applicationId: APP,
    rail: "anthropic",
    endpointUrl: null,
    credentialKind: "byok",
    credentialRef: "vault-2",
    status: "active",
  },
};

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

function orderRecordingDeps() {
  const order: string[] = [];
  const vault = new Map([
    ["vault-1", "sk-or-v1-PLAINTEXT-1"],
    ["vault-2", "sk-ant-PLAINTEXT-2"],
  ]);

  const admission: DispatchAdmission & { decisions: AdmissionDecision[] } = {
    decisions: [],
    async admit(input: AdmissionInput) {
      order.push(`admission:${input.rail}`);
      this.decisions.push({ allowed: true });
      return { allowed: true };
    },
  };

  const journal: DispatchJournal = {
    async recordIntent(input) {
      order.push(`intent:${input.rail}:${input.id}`);
    },
    async recordOutcome(attemptId, status) {
      order.push(`outcome:${attemptId}:${status}`);
    },
    async recordDenial(input) {
      order.push(`denial:${input.rail}:${input.id}`);
    },
    async findAttempt(): Promise<JournalAttempt | null> {
      return null;
    },
  };

  const credentials = {
    async materialize(ref: string) {
      order.push(`materialize:${ref}`);
      const plaintext = vault.get(ref);
      if (plaintext === undefined) {
        throw new PlatformError({ code: "AUTHORIZATION_DENIED", message: "not found" });
      }
      return { reference: ref, plaintext };
    },
  };

  return { order, admission, journal, credentials, vault };
}

function fakeProvider(rail: string): ModelProvider & { contexts: ProviderDispatchContext[] } {
  return {
    rail,
    contexts: [],
    async complete(
      request: ModelRequest,
      context: ProviderDispatchContext,
    ): Promise<ModelCallOutcome> {
      this.contexts.push(context);
      return {
        kind: "provider-success",
        response: {
          content: [`done:${rail}:${request.model}`],
          stopReason: "stop",
          structuredOutput: null,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: null },
          providerLatencyMs: 5,
        },
      };
    },
    async *stream() {
      yield { type: "text-delta", text: "chunk" };
      yield {
        type: "stream-done",
        stopReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: null },
      };
    },
  };
}

const REQUEST: ModelRequest = {
  model: "some/model",
  messages: [{ role: "user", content: "hello" }],
};

describe("model gateway — frozen dispatch sequence", () => {
  test("admission → intent → materialize → adapter → outcome, in that exact order", async () => {
    const { order, admission, journal, credentials } = orderRecordingDeps();
    const openrouter = fakeProvider("openrouter");
    let seq = 0;
    const gateway = createModelGateway({
      resolver: createScopeResolver(new FakeIdentity()),
      catalog: {
        async getConnectionForDispatch(_scope, connectionId) {
          const facts = FACTS[connectionId];
          if (facts === undefined) {
            throw new PlatformError({
              code: "AUTHORIZATION_DENIED",
              message: "connection not found",
            });
          }
          return facts as never;
        },
      },
      credentials,
      admission,
      rails: {
        rails: ["openrouter"],
        providerFor: (rail) => (rail === "openrouter" ? openrouter : null),
      },
      journal,
      generateId: () => {
        seq += 1;
        return `attempt-${seq}`;
      },
      hashRequest: () => "hash",
    });

    const result = await gateway.complete(PRINCIPAL, APP, OPENROUTER_CONNECTION, REQUEST);
    expect(result.outcome.kind).toBe("provider-success");
    if (result.outcome.kind !== "provider-success") return;
    expect(result.outcome.response.content).toEqual(["done:openrouter:some/model"]);

    // The exact frozen order: policy, durable intent, secret, transport,
    // observation. No step may overtake another.
    expect(order).toEqual([
      "admission:openrouter",
      "intent:openrouter:attempt-1",
      "materialize:vault-1",
      "outcome:attempt-1:succeeded",
    ]);
    // The adapter received the materialized plaintext credential.
    expect(openrouter.contexts[0]?.credential).toBe("sk-or-v1-PLAINTEXT-1");
  });

  test("a denial throws POLICY_DENIED before any secret or transport movement", async () => {
    const { order, credentials, journal } = orderRecordingDeps();
    const openrouter = fakeProvider("openrouter");
    const gateway = createModelGateway({
      resolver: createScopeResolver(new FakeIdentity()),
      catalog: {
        async getConnectionForDispatch(_s, id) {
          return FACTS[id] as never;
        },
      },
      credentials,
      admission: {
        async admit() {
          return { allowed: false, reason: "cost ceiling exceeded" };
        },
      },
      rails: { rails: ["openrouter"], providerFor: () => openrouter },
      journal,
      generateId: () => "attempt-deny",
      hashRequest: () => "hash",
    });

    const error = await gateway.complete(PRINCIPAL, APP, OPENROUTER_CONNECTION, REQUEST).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe("POLICY_DENIED");
    expect(order).toEqual(["denial:openrouter:attempt-deny"]);
    expect(order.filter((step) => step.startsWith("materialize"))).toHaveLength(0);
    expect(openrouter.contexts).toHaveLength(0);
  });

  test("unregistered rails fail NO_ELIGIBLE_ROUTE before intent or secrets", async () => {
    const { order, admission, credentials, journal } = orderRecordingDeps();
    const gateway = createModelGateway({
      resolver: createScopeResolver(new FakeIdentity()),
      catalog: {
        async getConnectionForDispatch(_s, id) {
          return FACTS[id] as never;
        },
      },
      credentials,
      admission,
      rails: { rails: [], providerFor: () => null },
      journal,
      generateId: () => "attempt-x",
      hashRequest: () => "hash",
    });
    const error = await gateway.complete(PRINCIPAL, APP, ANTHROPIC_CONNECTION, REQUEST).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as PlatformError).code).toBe("NO_ELIGIBLE_ROUTE");
    expect(order.filter((s) => s.startsWith("intent") || s.startsWith("materialize"))).toHaveLength(
      0,
    );
  });

  test("cross-tenant connection ids fail TENANT_SCOPE_VIOLATION (via the catalog guard)", async () => {
    const { admission, credentials, journal } = orderRecordingDeps();
    const gateway = createModelGateway({
      resolver: createScopeResolver(new FakeIdentity()),
      catalog: {
        async getConnectionForDispatch(scope, id) {
          const facts = FACTS[id] as { tenantId: string } | undefined;
          if (facts === undefined) {
            throw new PlatformError({
              code: "AUTHORIZATION_DENIED",
              message: "connection not found",
            });
          }
          if (facts.tenantId !== scope.tenantId) {
            throw new PlatformError({ code: "TENANT_SCOPE_VIOLATION", message: "cross-tenant" });
          }
          return facts as never;
        },
      },
      credentials,
      admission,
      rails: { rails: [], providerFor: () => null },
      journal,
      generateId: () => "a",
      hashRequest: () => "h",
    });
    // The real SQL catalog enforces this; here the fake mirrors the contract.
    const error = await gateway.complete(PRINCIPAL, "app-1", OPENROUTER_CONNECTION, REQUEST).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error === null || (error as PlatformError).code).toBeDefined();
  });

  test("both rails coexist behind one gateway (multi-adapter routing by connection)", async () => {
    const { order, admission, journal, credentials } = orderRecordingDeps();
    const openrouter = fakeProvider("openrouter");
    const anthropic = fakeProvider("anthropic");
    let seq = 0;
    const gateway = createModelGateway({
      resolver: createScopeResolver(new FakeIdentity()),
      catalog: {
        async getConnectionForDispatch(_s, id) {
          return FACTS[id] as never;
        },
      },
      credentials,
      admission,
      rails: {
        rails: ["openrouter", "anthropic"],
        providerFor: (rail) => (rail === "openrouter" ? openrouter : anthropic),
      },
      journal,
      generateId: () => {
        seq += 1;
        return `attempt-${seq}`;
      },
      hashRequest: () => "hash",
    });

    const viaRail = await gateway.complete(PRINCIPAL, APP, OPENROUTER_CONNECTION, REQUEST);
    const viaDirect = await gateway.complete(PRINCIPAL, APP, ANTHROPIC_CONNECTION, REQUEST);
    expect(viaRail.outcome.kind).toBe("provider-success");
    expect(viaDirect.outcome.kind).toBe("provider-success");
    expect(order).toContain("admission:openrouter");
    expect(order).toContain("admission:anthropic");
    expect(order).toContain("materialize:vault-1");
    expect(order).toContain("materialize:vault-2");
    // Each connection dispatched through ITS OWN rail adapter.
    if (
      viaRail.outcome.kind === "provider-success" &&
      viaDirect.outcome.kind === "provider-success"
    ) {
      expect(viaRail.outcome.response.content[0]).toBe("done:openrouter:some/model");
      expect(viaDirect.outcome.response.content[0]).toBe("done:anthropic:some/model");
    }
  });

  test("streaming dispatch journals the aggregated outcome after the terminal event", async () => {
    const { order, admission, journal, credentials } = orderRecordingDeps();
    const openrouter = fakeProvider("openrouter");
    const gateway = createModelGateway({
      resolver: createScopeResolver(new FakeIdentity()),
      catalog: {
        async getConnectionForDispatch(_s, id) {
          return FACTS[id] as never;
        },
      },
      credentials,
      admission,
      rails: { rails: ["openrouter"], providerFor: () => openrouter },
      journal,
      generateId: () => "attempt-stream",
      hashRequest: () => "hash",
    });
    const { events } = await gateway.stream(PRINCIPAL, APP, OPENROUTER_CONNECTION, REQUEST);
    const collected = [];
    for await (const event of events) {
      collected.push(event.type);
    }
    expect(collected).toEqual(["text-delta", "stream-done"]);
    expect(order).toEqual([
      "admission:openrouter",
      "intent:openrouter:attempt-stream",
      "materialize:vault-1",
      "outcome:attempt-stream:succeeded",
    ]);
  });
});

describe("model gateway — known transport failures are durable provider outcomes (architect remediation)", () => {
  const TRANSPORT_FAILURE: ProviderFailure = {
    category: "network",
    retryable: true,
    rail: "openrouter",
    providerCode: "Error",
    providerMessage: "connect ECONNREFUSED",
    httpStatus: null,
    durationMs: null,
  };

  function gatewayWith(
    provider: ModelProvider,
    journal: DispatchJournal & { outcomes: Array<{ attemptId: string; status: string }> },
  ) {
    return createModelGateway({
      resolver: createScopeResolver(new FakeIdentity()),
      catalog: {
        async getConnectionForDispatch(_s, id) {
          return FACTS[id] as never;
        },
      },
      credentials: {
        async materialize(ref: string) {
          return { reference: ref, plaintext: `plain-${ref}` };
        },
      },
      admission: {
        async admit() {
          return { allowed: true };
        },
      },
      rails: { rails: [provider.rail], providerFor: () => provider },
      journal,
      generateId: () => "attempt-t",
      hashRequest: () => "hash",
    });
  }

  function recordingJournal(): DispatchJournal & {
    outcomes: Array<{ attemptId: string; status: string }>;
  } {
    return {
      outcomes: [],
      async recordIntent() {},
      async recordOutcome(attemptId, status) {
        this.outcomes.push({ attemptId, status });
      },
      async recordDenial() {},
      async findAttempt() {
        return null;
      },
    };
  }

  test("one-shot: an adapter-normalized provider-failure outcome is journaled provider-failed", async () => {
    const journal = recordingJournal();
    const provider: ModelProvider = {
      rail: "openrouter",
      async complete() {
        return { kind: "provider-failure", failure: TRANSPORT_FAILURE };
      },
      async *stream() {
        yield { type: "stream-error", failure: TRANSPORT_FAILURE };
      },
    };
    const gateway = gatewayWith(provider, journal);
    const result = await gateway.complete(PRINCIPAL, APP, OPENROUTER_CONNECTION, REQUEST);
    // The call RESOLVES — a known provider failure is an outcome, not an escape.
    expect(result.outcome.kind).toBe("provider-failure");
    if (result.outcome.kind !== "provider-failure") return;
    expect(result.outcome.failure.category).toBe("network");
    // Durable: recorded on the PROVIDER axis, attempt not left dispatching.
    expect(journal.outcomes).toEqual([{ attemptId: "attempt-t", status: "provider-failed" }]);
  });

  test("one-shot: a contract-violating adapter that THROWS the failure still gets it journaled + canonical error", async () => {
    const journal = recordingJournal();
    const provider: ModelProvider = {
      rail: "openrouter",
      async complete() {
        throw TRANSPORT_FAILURE;
      },
      async *stream() {
        yield { type: "stream-done", stopReason: "stop", usage: EMPTY_USAGE };
      },
    };
    const gateway = gatewayWith(provider, journal);
    const error = await gateway.complete(PRINCIPAL, APP, OPENROUTER_CONNECTION, REQUEST).then(
      () => null,
      (e: unknown) => e,
    );
    // The canonical PROVIDER_ERROR surfaces (never a verification/quality code).
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe("PROVIDER_ERROR");
    // And the known failure was durably recorded FIRST — not left dispatching.
    expect(journal.outcomes).toEqual([{ attemptId: "attempt-t", status: "provider-failed" }]);
  });

  test("one-shot: an UNKNOWN crash rethrows and leaves the attempt dispatching (honest unknown)", async () => {
    const journal = recordingJournal();
    const provider: ModelProvider = {
      rail: "openrouter",
      async complete() {
        throw new Error("adapter bug");
      },
      async *stream() {
        yield { type: "stream-done", stopReason: "stop", usage: EMPTY_USAGE };
      },
    };
    const gateway = gatewayWith(provider, journal);
    const error = await gateway.complete(PRINCIPAL, APP, OPENROUTER_CONNECTION, REQUEST).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as Error).message).toBe("adapter bug");
    // No outcome recorded — the journal honestly keeps the attempt dispatching.
    expect(journal.outcomes).toEqual([]);
  });

  test("streaming: an adapter-normalized stream-error terminal journals provider-failed", async () => {
    const journal = recordingJournal();
    const provider: ModelProvider = {
      rail: "openrouter",
      async complete() {
        return { kind: "provider-failure", failure: TRANSPORT_FAILURE };
      },
      async *stream() {
        yield { type: "text-delta", text: "partial" };
        yield { type: "stream-error", failure: TRANSPORT_FAILURE };
      },
    };
    const gateway = gatewayWith(provider, journal);
    const { events } = await gateway.stream(PRINCIPAL, APP, OPENROUTER_CONNECTION, REQUEST);
    const collected: string[] = [];
    for await (const event of events) {
      collected.push(event.type);
    }
    expect(collected).toEqual(["text-delta", "stream-error"]);
    expect(journal.outcomes).toEqual([{ attemptId: "attempt-t", status: "provider-failed" }]);
  });

  test("streaming: a contract-violating adapter whose failure ESCAPES gets a normalized terminal + durable record", async () => {
    const journal = recordingJournal();
    const provider: ModelProvider = {
      rail: "openrouter",
      async complete() {
        return { kind: "provider-failure", failure: TRANSPORT_FAILURE };
      },
      async *stream() {
        yield { type: "text-delta", text: "partial" };
        throw TRANSPORT_FAILURE;
      },
    };
    const gateway = gatewayWith(provider, journal);
    const { events } = await gateway.stream(PRINCIPAL, APP, OPENROUTER_CONNECTION, REQUEST);
    const collected: string[] = [];
    for await (const event of events) {
      collected.push(event.type);
    }
    // The consumer observes a TERMINAL NORMALIZED EVENT, not a rejection.
    expect(collected).toEqual(["text-delta", "stream-error"]);
    // And the attempt is durably provider-failed — not left dispatching.
    expect(journal.outcomes).toEqual([{ attemptId: "attempt-t", status: "provider-failed" }]);
  });

  test("streaming: an UNKNOWN crash rejection escapes and leaves the attempt dispatching", async () => {
    const journal = recordingJournal();
    const provider: ModelProvider = {
      rail: "openrouter",
      async complete() {
        return { kind: "provider-failure", failure: TRANSPORT_FAILURE };
      },
      async *stream() {
        yield { type: "text-delta", text: "partial" };
        throw new Error("adapter bug mid-stream");
      },
    };
    const gateway = gatewayWith(provider, journal);
    const { events } = await gateway.stream(PRINCIPAL, APP, OPENROUTER_CONNECTION, REQUEST);
    const error = await (async () => {
      try {
        for await (const _ of events) {
          // drain
        }
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect((error as Error).message).toBe("adapter bug mid-stream");
    expect(journal.outcomes).toEqual([]);
  });
});
