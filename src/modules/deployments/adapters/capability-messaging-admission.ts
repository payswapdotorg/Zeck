/**
 * Capability messaging-admission adapter (deployments module;
 * WORK-025).
 *
 * Implements the deployments module's REQUIRED
 * `MessagingCapabilityAdmission` port against the REAL capabilities
 * module registry (the WORK-005 authority — the same one-claim
 * authority the planning module and the realtime fabric consult). The
 * messaging conversation service consults this seam BEFORE any rail
 * send and BEFORE any paid inference dispatch: the pinned plan's
 * declared capabilities plus the rail's neutral adapter capability
 * must be resolvable in the arbitrated catalog; unmet requirements
 * fail closed `CAPABILITY_UNAVAILABLE` with zero side effects (the
 * models-gateway INT-002 discipline applied to the messaging
 * boundary).
 *
 * Type + runtime coupling is to the capabilities PUBLIC barrel only.
 */

import type { CapabilityRegistry, CapabilityResolution } from "../../capabilities/public";
import type {
  MessagingCapabilityAdmission,
  MessagingCapabilityAdmissionDecision,
  MessagingCapabilityAdmissionRequest,
} from "../ports/messaging-admission";

export function createCapabilityMessagingAdmission(
  registry: CapabilityRegistry,
): MessagingCapabilityAdmission {
  return {
    async resolve(
      request: MessagingCapabilityAdmissionRequest,
    ): Promise<MessagingCapabilityAdmissionDecision> {
      // The deployment profile's neutral capability identifiers and the
      // rail's adapter capability id are RUNTIME-kind requirements (the
      // neutral messaging vocabulary); the registry arbitrates their
      // satisfaction, versions and evidence.
      const requirements = [
        ...request.requiredCapabilities.map((capabilityId) => ({
          id: capabilityId,
          kind: "runtime" as const,
        })),
        { id: request.railCapabilityId, kind: "runtime" as const },
      ];
      const resolution: CapabilityResolution = await registry.resolve({ requirements });
      if (!resolution.satisfied) {
        return { satisfied: false, unmet: resolution.unmet.map((item) => item.requirementId) };
      }
      return { satisfied: true, unmet: [] };
    },
  };
}
