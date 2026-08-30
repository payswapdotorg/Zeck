/**
 * Capability authority adapter (planning module adapter; WORK-009 /
 * INT-002).
 *
 * Wraps the WORK-005 capability registry's public surface: the planner
 * resolves its task capability profile through THE single capability
 * authority — never a rail, never a provider, never a local copy of the
 * catalog.
 */

import type {
  CapabilityRegistry,
  CapabilityResolution,
  TaskCapabilityProfile,
} from "../../capabilities/public";
import type { PlanningCapabilityAuthority } from "../ports/capability-authority";

export function createCapabilityAuthorityAdapter(
  registry: CapabilityRegistry,
): PlanningCapabilityAuthority {
  return {
    async resolve(profile: TaskCapabilityProfile): Promise<CapabilityResolution> {
      return registry.resolve(profile);
    },
    get catalogRevision(): string {
      return registry.catalogRevision;
    },
  };
}
