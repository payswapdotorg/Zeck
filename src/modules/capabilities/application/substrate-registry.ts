/**
 * Substrate registry application (capabilities module application;
 * WORK-031, CSX-001/CSX-004).
 *
 * THE substrate admission surface: validate → publish the execution
 * capability claim through the EXISTING capability registry (the one
 * authority) → insert the durable substrate record → lifecycle
 * (suspend/resume/retire, guarded). The claim and the record are
 * published together; the registry's arbitration is the capability
 * authority's, the store's is the substrate record's.
 *
 * Authority properties: there is NO policy seam, budget seam or
 * execution-transition seam here — a substrate CLAIM is metadata
 * (claims are distinct from authorization to use them); admission
 * happens in the existing authorities at planning/execution time.
 */

import { PlatformError } from "../../../shared/errors";
import type {
  ComputationalSubstrateInput,
  ComputationalSubstrateRecord,
  SubstrateLifecycleStatus,
} from "../domain/substrate";
import {
  canonicalSubstrateJson,
  substrateCapabilityClaim,
  validateComputationalSubstrate,
} from "../domain/substrate";
import type { CapabilityRegistry } from "../ports/capability-registry";
import type { SubstrateStore } from "../ports/substrate-store";

export interface SubstrateRegistryDeps {
  readonly store: SubstrateStore;
  /** The EXISTING capability registry — the one claim authority. */
  readonly registry: CapabilityRegistry;
  readonly digest: (canonical: string) => string;
  readonly generateId: () => string;
  readonly now: () => Date;
}

export interface SubstrateActor {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface SubstrateRegistry {
  publish(
    input: ComputationalSubstrateInput,
    actor: SubstrateActor,
  ): Promise<{
    readonly status: "published" | "converged";
    readonly record: ComputationalSubstrateRecord;
  }>;
  get(
    applicationId: string,
    substrateId: string,
    version: string,
  ): Promise<ComputationalSubstrateRecord | null>;
  list(applicationId: string): Promise<readonly ComputationalSubstrateRecord[]>;
  listAvailableByWorkloadClass(
    applicationId: string,
    workloadClass: string,
  ): Promise<readonly ComputationalSubstrateRecord[]>;
  suspend(input: {
    readonly applicationId: string;
    readonly substrateId: string;
    readonly version: string;
    readonly actor: SubstrateActor;
  }): Promise<ComputationalSubstrateRecord>;
  resume(input: {
    readonly applicationId: string;
    readonly substrateId: string;
    readonly version: string;
    readonly actor: SubstrateActor;
  }): Promise<ComputationalSubstrateRecord>;
  retire(input: {
    readonly applicationId: string;
    readonly substrateId: string;
    readonly version: string;
    readonly actor: SubstrateActor;
  }): Promise<ComputationalSubstrateRecord>;
}

export function createSubstrateRegistry(deps: SubstrateRegistryDeps): SubstrateRegistry {
  const { store, registry, digest, generateId, now } = deps;
  const iso = () => now().toISOString();

  const requireScope = (actor: SubstrateActor, record: ComputationalSubstrateRecord): void => {
    if (record.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "substrate belongs to another tenant",
      });
    }
  };

  const transition = async (
    input: {
      readonly applicationId: string;
      readonly substrateId: string;
      readonly version: string;
      readonly actor: SubstrateActor;
    },
    from: SubstrateLifecycleStatus,
    to: SubstrateLifecycleStatus,
  ): Promise<ComputationalSubstrateRecord> => {
    const record = await store.find(input.applicationId, input.substrateId, input.version);
    if (record === null) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `substrate ${input.substrateId}@${input.version} is not registered in this application`,
      });
    }
    requireScope(input.actor, record);
    return store.updateStatus({
      applicationId: input.applicationId,
      substrateId: input.substrateId,
      version: input.version,
      from,
      to,
    });
  };

  return {
    async publish(input, actor) {
      const check = validateComputationalSubstrate(input);
      if (!check.valid) {
        throw new PlatformError({ code: "CAPABILITY_UNAVAILABLE", message: check.reason });
      }
      const bodyDigest = digest(canonicalSubstrateJson(input));
      // The capability claim publishes through the EXISTING registry
      // (the one authority) — substrate metadata never creates a
      // second capability registry.
      const { claim, evidenceReference } = substrateCapabilityClaim(input);
      await registry.publish({
        claim,
        provenance: { publisher: `substrates:${actor.actorId}`, publishedAt: iso() },
        evidence: { kind: "adapter-declared", reference: evidenceReference },
      });
      const outcome = await store.insert({
        record: {
          id: generateId(),
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          substrateId: input.substrateId,
          version: input.version,
          workloadClasses: [...input.workloadClasses],
          modalities: [...input.modalities],
          latencyClass: input.latencyClass,
          resource: { ...input.resource },
          isolation: input.isolation,
          sideEffectClasses: [...input.sideEffectClasses],
          executionCapability: { ...input.executionCapability },
          adapterRef: input.adapterRef,
          description: input.description ?? null,
          createdBy: actor.actorId,
        },
        digest: bodyDigest,
      });
      return { status: outcome.status, record: outcome.record };
    },

    async get(applicationId, substrateId, version) {
      return store.find(applicationId, substrateId, version);
    },

    async list(applicationId) {
      return store.list(applicationId);
    },

    async listAvailableByWorkloadClass(applicationId, workloadClass) {
      return store.listAvailableByWorkloadClass(applicationId, workloadClass);
    },

    async suspend(input) {
      return transition(input, "available", "suspended");
    },

    async resume(input) {
      return transition(input, "suspended", "available");
    },

    async retire(input) {
      const record = await store.find(input.applicationId, input.substrateId, input.version);
      if (record === null) {
        throw new PlatformError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `substrate ${input.substrateId}@${input.version} is not registered in this application`,
        });
      }
      requireScope(input.actor, record);
      // The one legal retired transition comes from EITHER live state.
      return store.updateStatus({
        applicationId: input.applicationId,
        substrateId: input.substrateId,
        version: input.version,
        from: record.status === "available" ? "available" : "suspended",
        to: "retired",
      });
    },
  };
}
