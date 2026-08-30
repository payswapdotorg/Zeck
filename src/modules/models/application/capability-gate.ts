/**
 * Registry-backed capability gate (models module application, WORK-005).
 *
 * Composition wiring between the capability authority (capabilities module
 * public surface) and the model gateway's `TaskCapabilityResolution` port.
 * The gateway codes against the PORT; this adapter delegates to the
 * registry — there is no second capability authority and no bypass path.
 */

import type { CapabilityRegistry } from "../../capabilities/public";
import type { TaskCapabilityResolution } from "../ports/capability-gate";

export function createCapabilityGate(registry: CapabilityRegistry): TaskCapabilityResolution {
  return {
    resolve: (profile) => registry.resolve(profile),
  };
}
