/**
 * Registry-backed edge capability gate (edge integration adapter; WORK-029).
 *
 * Composition wiring between the capability authority (the capabilities
 * module's public registry — WORK-005) and the edge integration's
 * `EdgeCapabilityGate` port: the service codes against the PORT; this
 * adapter delegates to the REAL registry (the `createToolCapabilityGate`
 * / `createComputerUseCapabilityGate` precedent). There is no second
 * capability authority and no bypass path: the requirement atoms (a
 * device's declared evidence atoms at envelope admission, the
 * `edge-channel-<channel>` atom (the neutral-vocabulary slug the REAL registry resolves) at command admission) resolve through
 * the same arbitrated catalog every other governed surface consults.
 */

import type { CapabilityRegistry } from "../../../modules/capabilities/public";
import type { EdgeCapabilityGate, EdgeCapabilityGateRequest } from "../ports/edge-admission";

export function createEdgeCapabilityGate(registry: CapabilityRegistry): EdgeCapabilityGate {
  return {
    async resolve(request: EdgeCapabilityGateRequest) {
      const resolution = await registry.resolve({
        requirements: request.requirementAtoms.map((atom) => ({
          id: atom,
          kind: "tool" as const,
          minVersion: "1.0.0",
        })),
      });
      if (resolution.satisfied) {
        return {
          satisfied: true,
          unmet: [] as readonly string[],
          satisfactions: resolution.satisfactions.map(
            (entry) => `${entry.claimId}@${entry.claimVersion}:${entry.evidenceKind}`,
          ),
        };
      }
      return {
        satisfied: false,
        unmet: resolution.unmet.map((entry) => entry.requirementId),
        satisfactions: [] as readonly string[],
      };
    },
  };
}
