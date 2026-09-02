/**
 * Capability realtime-admission adapter (deployments module; WORK-024).
 *
 * Implements the deployments module's REQUIRED
 * `RealtimeCapabilityAdmission` port against the REAL capabilities
 * module registry (the WORK-005 authority — the same one-claim
 * authority the planning module consults). The realtime session
 * service consults this seam BEFORE any rail delivery and BEFORE any
 * paid inference dispatch: the pinned plan's declared capabilities
 * plus the rail's neutral adapter capability must be resolvable in the
 * arbitrated catalog; unmet requirements fail closed
 * `CAPABILITY_UNAVAILABLE` with zero side effects (the models-gateway
 * INT-002 discipline applied to the realtime boundary).
 *
 * Type + runtime coupling is to the capabilities PUBLIC barrel only.
 */

import type { CapabilityRegistry, CapabilityResolution } from "../../capabilities/public";
import type {
  RealtimeCapabilityAdmission,
  RealtimeCapabilityAdmissionDecision,
  RealtimeCapabilityAdmissionRequest,
} from "../ports/realtime-admission";

/** Requirement ids the adapter derives from the neutral declarations. */
function requirementIdOf(capabilityId: string): string {
  return capabilityId;
}

export function createCapabilityRealtimeAdmission(
  registry: CapabilityRegistry,
): RealtimeCapabilityAdmission {
  return {
    async resolve(
      request: RealtimeCapabilityAdmissionRequest,
    ): Promise<RealtimeCapabilityAdmissionDecision> {
      // The deployment profile's neutral capability identifiers and the
      // rail's adapter capability id are RUNTIME-kind requirements (the
      // neutral realtime vocabulary); the registry arbitrates their
      // satisfaction, versions and evidence.
      const requirements = [
        ...request.requiredCapabilities.map((capabilityId) => ({
          id: requirementIdOf(capabilityId),
          kind: "runtime" as const,
        })),
        { id: requirementIdOf(request.railCapabilityId), kind: "runtime" as const },
      ];
      const resolution: CapabilityResolution = await registry.resolve({ requirements });
      if (!resolution.satisfied) {
        return { satisfied: false, unmet: resolution.unmet.map((item) => item.requirementId) };
      }
      return { satisfied: true, unmet: [] };
    },
  };
}
