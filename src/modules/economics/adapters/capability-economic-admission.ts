/**
 * Capability economic-admission adapter (economics module; WORK-032).
 *
 * Implements the economics module's REQUIRED `EconomicCapabilityAdmissionPort`
 * against the REAL capability authority (the WORK-008 registry): the
 * capability authority stays singular — an economic action's required
 * capabilities are resolved through the registry BEFORE any budget
 * reservation or authorization issuance. The adapter maps the neutral
 * `EconomicCapabilityRequirement` onto the registry's
 * `CapabilityRequirement` (the vocabularies are identical by design —
 * economics mirrors the frozen capability kinds) and holds no resolution
 * logic of its own.
 */

import type { CapabilityRegistry } from "../../capabilities/public";
import type { EconomicActionRecord } from "../domain/economic-action";
import type {
  EconomicCapabilityAdmissionDecision,
  EconomicCapabilityAdmissionInput,
  EconomicCapabilityAdmissionPort,
} from "../ports/capability-admission";

export function createCapabilityEconomicAdmission(
  registry: CapabilityRegistry,
): EconomicCapabilityAdmissionPort {
  return {
    async resolve(
      input: EconomicCapabilityAdmissionInput,
    ): Promise<EconomicCapabilityAdmissionDecision> {
      const action: EconomicActionRecord = input.action;
      const resolution = await registry.resolve({
        requirements: action.requiredCapabilities.map((requirement) => ({
          id: requirement.name,
          kind: requirement.kind,
          ...(requirement.minVersion === undefined ? {} : { minVersion: requirement.minVersion }),
        })),
      });
      return {
        satisfied: resolution.satisfied,
        unmet: resolution.satisfied ? [] : resolution.unmet.map((unmet) => unmet.requirementId),
      };
    },
  };
}
