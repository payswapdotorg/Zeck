/**
 * Capability-order probe: drives the REAL model gateway with order-recording
 * fakes (including a rail-lookup-recording registry) — the dynamic side of
 * the capability-before-route discrimination proofs (INT-002).
 */

import { createScopeResolver } from "../../../src/modules/auth/application/scope-resolver";
import type { Actor, Principal, ProvisionActorInput } from "../../../src/modules/auth/domain/actor";
import type { MembershipRecord } from "../../../src/modules/auth/domain/scope";
import type { IdentityStore } from "../../../src/modules/auth/public";
import type {
  CapabilityResolution,
  TaskCapabilityProfile,
} from "../../../src/modules/capabilities/public";
import { createModelGateway } from "../../../src/modules/models/application/model-gateway";
import type { ModelCallOutcome } from "../../../src/modules/models/domain/outcome";
import type { ModelRequest } from "../../../src/modules/models/domain/request";
import type { TaskCapabilityResolution } from "../../../src/modules/models/ports/capability-gate";
import type {
  DispatchJournal,
  JournalAttempt,
} from "../../../src/modules/models/ports/dispatch-journal";
import type { ModelProvider } from "../../../src/modules/models/ports/model-provider";

const TENANT = "tenant-capability";
const APP = "app-capability";
const PRINCIPAL: Principal = {
  actorId: "actor-capability",
  authenticatedAt: "2026-01-01T00:00:00Z",
};

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

const REQUEST: ModelRequest = {
  model: "m",
  messages: [{ role: "user", content: "u" }],
  taskProfile: { requirements: [{ id: "structured-output", kind: "model" }] },
};

const SUCCESS_RESPONSE = {
  content: ["ok"],
  stopReason: "stop" as const,
  structuredOutput: null,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: null },
  providerLatencyMs: 1,
};
const SUCCESS: ModelCallOutcome = { kind: "provider-success", response: SUCCESS_RESPONSE };

export function buildCapabilityOrderProbe(options: { readonly satisfy: boolean }) {
  const steps: string[] = [];
  const railLookups: string[] = [];
  let denialReason: string | null = null;
  let resolvedProfile: TaskCapabilityProfile | null = null;

  const journal: DispatchJournal = {
    async recordIntent() {
      steps.push("intent");
    },
    async recordOutcome() {
      steps.push("outcome");
    },
    async recordDenial(_input, reason) {
      denialReason = reason;
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
      return SUCCESS;
    },
    async *stream() {
      steps.push("transport");
      yield { type: "stream-done", stopReason: "stop", usage: SUCCESS_RESPONSE.usage };
    },
  };

  const capabilities: TaskCapabilityResolution = {
    async resolve(profile) {
      resolvedProfile = profile;
      steps.push("capability");
      const resolution: CapabilityResolution = options.satisfy
        ? {
            satisfied: true,
            catalogRevision: "rev-1",
            satisfactions: [
              {
                requirementId: "structured-output",
                claimId: "structured-output",
                claimKind: "model",
                claimVersion: "1.0.0",
                evidenceKind: "adapter-declared",
                evidenceReference: "probe-evidence",
                publisher: "probe",
              },
            ],
          }
        : {
            satisfied: false,
            catalogRevision: "rev-1",
            unmet: [
              {
                requirementId: "structured-output",
                kind: "model",
                reason: "unknown-capability",
                minVersion: null,
              },
            ],
          };
      return resolution;
    },
  };

  const gateway = createModelGateway({
    resolver: createScopeResolver(new ProbeIdentity()),
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
        return { allowed: true };
      },
    },
    capabilities,
    rails: {
      rails: ["openrouter"],
      providerFor(rail) {
        railLookups.push(rail);
        steps.push("rail");
        return provider;
      },
    },
    journal,
    generateId: () => "attempt-capability",
    hashRequest: () => "hash",
  });

  return {
    steps,
    railLookups,
    getDenialReason: () => denialReason,
    get resolvedProfile() {
      return resolvedProfile;
    },
    complete: () => gateway.complete(PRINCIPAL, APP, "conn", REQUEST),
    stream: () => gateway.stream(PRINCIPAL, APP, "conn", REQUEST),
  };
}
