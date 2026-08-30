/**
 * Capability registry application service (capabilities module, WORK-005).
 *
 * THE authority for capability facts and task-profile resolution (INT-002).
 * Adapters publish facts INTO the registry; the registry validates every
 * fact (`validatePublishedFact`), arbitrates conflicts transactionally
 * in-memory (serialized publish decisions under the module lock) and serves
 * resolutions from the arbitrated catalog only — never from raw adapter
 * output.
 *
 * Arbitration rules (claim identity = `(id, kind, version)`, one kind per id):
 *   * invalid fact                     → `rejected` (validation failure)
 *   * id already bound to another kind → `rejected` (vocabulary conflict)
 *   * same (id, kind, version) with identical attributes → `converged`
 *     (the original record — its provenance/evidence — is retained)
 *   * same (id, kind, version) with different attributes → `rejected`
 *     (a version is immutable once arbitrated; corrections are new versions)
 *   * otherwise                        → `accepted` (catalog revision +1)
 */

import type {
  CapabilityClaimRecord,
  PublishedCapabilityFact,
  PublishOutcome,
} from "../domain/capability";
import { resolveProfile } from "../domain/resolution";
import { validatePublishedFact, validateRequirement } from "../domain/validation";
import { createAsyncLock } from "../internal/async-lock";
import type { CapabilityRegistry, CapabilityRegistryOptions } from "../ports/capability-registry";

const sameAttributes = (
  a: Readonly<Record<string, unknown>> | undefined,
  b: Readonly<Record<string, unknown>> | undefined,
): boolean => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/**
 * Build the capability registry over a catalog store. Construction ARBITRATES
 * the seed facts through the identical publish path (a seed fact that fails
 * validation fails construction — the code-resident catalog earns its place
 * in the registry like any adapter fact).
 */
export async function createCapabilityRegistry(
  options: CapabilityRegistryOptions,
): Promise<CapabilityRegistry> {
  const store = options.store;
  const validateFact = options.validateFact ?? validatePublishedFact;
  const lock = createAsyncLock();
  let revision = 0;

  const arbitration = async (fact: PublishedCapabilityFact): Promise<PublishOutcome> => {
    const validation = validateFact(fact);
    if (!validation.valid) {
      return { status: "rejected", reason: validation.reason };
    }
    const existing = await store.findById(fact.claim.id);
    for (const record of existing) {
      if (record.claim.kind !== fact.claim.kind) {
        return {
          status: "rejected",
          reason: `capability id ${fact.claim.id} is already bound to kind ${record.claim.kind}`,
        };
      }
      if (record.claim.version === fact.claim.version) {
        if (sameAttributes(record.claim.attributes, fact.claim.attributes)) {
          return { status: "converged", catalogRevision: `rev-${revision}` };
        }
        return {
          status: "rejected",
          reason: `claim ${fact.claim.id}@${fact.claim.version} is already arbitrated with different attributes`,
        };
      }
    }
    revision += 1;
    const record: CapabilityClaimRecord = {
      claim: fact.claim,
      provenance: fact.provenance,
      evidence: fact.evidence,
      acceptedAtRevision: `rev-${revision}`,
    };
    await store.insert(record);
    return { status: "accepted", catalogRevision: record.acceptedAtRevision };
  };

  const registry: CapabilityRegistry = {
    publish(fact) {
      // Every publish decision is serialized: concurrent identical publishes
      // converge to ONE accepted record + ONE revision bump (the in-memory
      // transaction boundary; no arbitration observes a half-applied publish).
      return lock.run(() => arbitration(fact));
    },

    async resolve(profile) {
      // Requirements are validated first — an invalid profile fails closed.
      for (const requirement of profile?.requirements ?? []) {
        const validation = validateRequirement(requirement);
        if (!validation.valid) {
          return {
            satisfied: false,
            catalogRevision: `rev-${revision}`,
            unmet: [
              {
                requirementId: typeof requirement?.id === "string" ? requirement.id : "unknown",
                kind: requirement?.kind ?? null,
                reason: "invalid-requirement",
                minVersion: requirement?.minVersion ?? null,
              },
            ],
          };
        }
      }
      const claims = await store.list();
      return resolveProfile(claims, profile, `rev-${revision}`);
    },

    listClaims() {
      return store.list();
    },

    get catalogRevision() {
      return `rev-${revision}`;
    },
  };

  if (options.seed !== undefined) {
    for (const fact of options.seed) {
      const outcome = await registry.publish(fact);
      if (outcome.status === "rejected") {
        throw new Error(
          `seed capability fact rejected by registry arbitration: ${fact.claim.id} — ${outcome.reason}`,
        );
      }
    }
  }

  return registry;
}
