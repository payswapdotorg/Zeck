/**
 * Capability media-admission adapter (deployments module; WORK-026).
 *
 * Implements the deployments module's REQUIRED
 * `MediaCapabilityAdmission` port against the REAL capabilities
 * module registry (the WORK-005 authority — the same one-claim
 * authority the planning module, the realtime and messaging fabrics
 * consult). The media generation service consults this seam BEFORE
 * the PAID rail dispatch: the pinned plan's declared capabilities
 * plus the rail's neutral adapter capability plus the neutral
 * media-generation capability atom (`media-generation:<kind>`) must
 * be resolvable in the arbitrated catalog; unmet requirements fail
 * closed `CAPABILITY_UNAVAILABLE` with zero paid dispatches (the
 * capability-before-provider discipline — the provider rail is
 * dispatched only AFTER capability admission, never before).
 *
 * Type + runtime coupling is to the capabilities PUBLIC barrel only.
 */

import type { CapabilityRegistry, CapabilityResolution } from "../../capabilities/public";
import type {
  MediaCapabilityAdmission,
  MediaCapabilityAdmissionDecision,
  MediaCapabilityAdmissionRequest,
} from "../ports/media-admission";

export function createCapabilityMediaAdmission(
  registry: CapabilityRegistry,
): MediaCapabilityAdmission {
  return {
    async resolve(
      request: MediaCapabilityAdmissionRequest,
    ): Promise<MediaCapabilityAdmissionDecision> {
      // The deployment profile's neutral capability identifiers, the
      // rail's adapter capability id and the generation-kind atom are
      // RUNTIME-kind requirements (the neutral media vocabulary); the
      // registry arbitrates their satisfaction, versions and evidence.
      const requirements = [
        ...request.requiredCapabilities.map((capabilityId) => ({
          id: capabilityId,
          kind: "runtime" as const,
        })),
        { id: request.railCapabilityId, kind: "runtime" as const },
        { id: `media-generation:${request.generationKind}`, kind: "runtime" as const },
      ];
      const resolution: CapabilityResolution = await registry.resolve({ requirements });
      if (!resolution.satisfied) {
        return { satisfied: false, unmet: resolution.unmet.map((item) => item.requirementId) };
      }
      return { satisfied: true, unmet: [] };
    },
  };
}
