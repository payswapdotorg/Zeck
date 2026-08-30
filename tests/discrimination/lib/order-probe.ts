/**
 * Order probe: drives the REAL model gateway with order-recording fakes and
 * exposes the observed step sequence — the dynamic side of the
 * policy-before-dispatch and secrets-last discrimination proofs.
 */

import { createScopeResolver } from "../../../src/modules/auth/application/scope-resolver";
import type { Actor, Principal, ProvisionActorInput } from "../../../src/modules/auth/domain/actor";
import type { MembershipRecord } from "../../../src/modules/auth/domain/scope";
import type { IdentityStore } from "../../../src/modules/auth/public";
import { createModelGateway } from "../../../src/modules/models/application/model-gateway";
import type { ModelRequest } from "../../../src/modules/models/domain/request";
import type {
  DispatchJournal,
  JournalAttempt,
} from "../../../src/modules/models/ports/dispatch-journal";
import type { ModelProvider } from "../../../src/modules/models/ports/model-provider";
import { PlatformError } from "../../../src/shared/errors";

const TENANT = "tenant-order";
const APP = "app-order";
const PRINCIPAL: Principal = { actorId: "actor-order", authenticatedAt: "2026-01-01T00:00:00Z" };

class OrderIdentity implements IdentityStore {
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

const REQUEST: ModelRequest = { model: "m", messages: [{ role: "user", content: "u" }] };

export function buildOrderProbe(options?: { readonly allow?: boolean }) {
  const allow = options?.allow ?? true;
  const steps: string[] = [];

  const journal: DispatchJournal = {
    async recordIntent() {
      steps.push("intent");
    },
    async recordOutcome() {
      steps.push("outcome");
    },
    async recordDenial() {
      steps.push("denial");
    },
    async findAttempt(): Promise<JournalAttempt | null> {
      return null;
    },
  };

  const provider: ModelProvider = {
    rail: "openrouter",
    async complete() {
      steps.push("transport");
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
      yield {
        type: "stream-done" as const,
        stopReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: null },
      };
    },
  };

  const gateway = createModelGateway({
    resolver: createScopeResolver(new OrderIdentity()),
    catalog: {
      async getConnectionForDispatch() {
        return {
          id: "conn",
          tenantId: TENANT,
          applicationId: APP,
          rail: "openrouter",
          endpointUrl: null,
          credentialKind: "byok",
          credentialRef: "vault-ref",
          status: "active",
        };
      },
    },
    credentials: {
      async materialize() {
        steps.push("materialize");
        return { reference: "vault-ref", plaintext: "material" };
      },
    },
    admission: {
      async admit() {
        steps.push("admission");
        return allow ? { allowed: true } : { allowed: false, reason: "probe-deny" };
      },
    },
    rails: { rails: ["openrouter"], providerFor: () => provider },
    journal,
    generateId: () => "attempt-order",
    hashRequest: () => "hash",
  });

  return {
    steps,
    async dispatchAllowed(): Promise<unknown> {
      try {
        return await gateway.complete(PRINCIPAL, APP, "conn", REQUEST);
      } catch (error) {
        if (error instanceof PlatformError && error.code === "POLICY_DENIED") {
          return null;
        }
        throw error;
      }
    },
  };
}
