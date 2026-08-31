/**
 * Registry-backed capability gate (sandbox module wiring, WORK-012).
 *
 * Composition wiring between the capability authority (capabilities module
 * public surface) and the sandbox service's `SandboxCapabilityResolution`
 * port — the WORK-010 `createToolCapabilityGate` precedent, mirrored: the
 * service codes against the PORT; this adapter delegates to the registry.
 * There is no second capability authority and no bypass path.
 */

import type { CapabilityRegistry } from "../../capabilities/public";
import type { SandboxCapabilityResolution } from "../ports/sandbox-capability-gate";

export function createSandboxCapabilityGate(
  registry: CapabilityRegistry,
): SandboxCapabilityResolution {
  return {
    resolve: (profile) => registry.resolve(profile),
  };
}
