/**
 * Registry-backed capability gate (tools module application wiring, WORK-010).
 *
 * Composition wiring between the capability authority (capabilities module
 * public surface) and the tool runtime's `ToolCapabilityResolution` port —
 * the WORK-005 models-gate precedent, mirrored: the runtime codes against
 * the PORT; this adapter delegates to the registry. There is no second
 * capability authority and no bypass path.
 */

import type { CapabilityRegistry } from "../../capabilities/public";
import type { ToolCapabilityResolution } from "../ports/tool-capability-gate";

export function createToolCapabilityGate(registry: CapabilityRegistry): ToolCapabilityResolution {
  return {
    resolve: (profile) => registry.resolve(profile),
  };
}
