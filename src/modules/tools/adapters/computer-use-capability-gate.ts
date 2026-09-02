/**
 * Registry-backed computer-use capability gate (tools module adapter;
 * WORK-027).
 *
 * Composition wiring between the capability authority (the capabilities
 * module's public registry — WORK-005) and the tools module's
 * `ComputerUseCapabilityGate` port: the service codes against the PORT;
 * this adapter delegates to the REAL registry (the `createToolCapabilityGate`
 * precedent, mirrored). There is no second capability authority and no
 * bypass path: the requirement atoms of the admitted route
 * (`computer-use-deterministic` / `computer-use-browser` /
 * `computer-use-desktop`) resolve through the same arbitrated catalog
 * every other governed surface consults.
 */

import type { CapabilityRegistry } from "../../capabilities/public";
import type {
  ComputerUseCapabilityGate,
  ComputerUseCapabilityGateRequest,
} from "../ports/computer-use-admission";

export function createComputerUseCapabilityGate(
  registry: CapabilityRegistry,
): ComputerUseCapabilityGate {
  return {
    async resolve(request: ComputerUseCapabilityGateRequest) {
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
