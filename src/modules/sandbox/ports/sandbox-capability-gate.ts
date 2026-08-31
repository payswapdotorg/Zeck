/**
 * Sandbox capability-resolution port (sandbox module outbound; WORK-012).
 *
 * ENFORCES the frozen "capability before provider" invariant
 * (`spec/architecture.md` §2.5, `IMPLEMENTATION.md` §7 dispatch sequence)
 * at the sandbox boundary: the service consults the CAPABILITY AUTHORITY
 * (the capabilities module's registry — never a second registry here) to
 * resolve the environment's declared runtime capability BEFORE any
 * provider is selected or dispatched. An unsatisfied runtime capability
 * fails canonical `CAPABILITY_UNAVAILABLE` before anything durable is
 * admitted — exactly as an unsatisfied tool capability blocks tool
 * dispatch (the WORK-010 `ToolCapabilityResolution` precedent, mirrored).
 *
 * `no-execution` environments declare no runtime capability (nothing
 * runs) and skip this gate by construction.
 *
 * There is deliberately NO default/skip implementation in this module: a
 * service cannot be constructed without a capability authority.
 */

import type { CapabilityResolution, TaskCapabilityProfile } from "../../capabilities/public";

/** Resolves a capability profile against the capability authority. */
export interface SandboxCapabilityResolution {
  resolve(profile: TaskCapabilityProfile): Promise<CapabilityResolution>;
}
