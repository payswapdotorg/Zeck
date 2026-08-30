/**
 * Tool capability-resolution port (tools module outbound; WORK-010).
 *
 * ENFORCES the frozen "capability before provider/tool execution" invariant
 * (`spec/architecture.md` §2.5, `IMPLEMENTATION.md` §7 dispatch sequence) at
 * the tool boundary: the runtime consults the CAPABILITY AUTHORITY (the
 * capabilities module's registry — never a second registry here) to
 * resolve the tool contract's declared capability identity BEFORE the
 * adapter executes. An unsatisfied capability requirement fails canonical
 * `CAPABILITY_UNAVAILABLE` before dispatch, exactly as an unsatisfied task
 * profile blocks model routing (models `TaskCapabilityResolution`, the
 * WORK-005 precedent).
 *
 * There is deliberately NO default/skip implementation in this module: a
 * runtime cannot be constructed without a capability authority.
 */

import type { CapabilityResolution, TaskCapabilityProfile } from "../../capabilities/public";

/** Resolves a capability profile against the capability authority. */
export interface ToolCapabilityResolution {
  resolve(profile: TaskCapabilityProfile): Promise<CapabilityResolution>;
}
