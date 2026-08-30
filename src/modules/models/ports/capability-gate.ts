/**
 * Task capability resolution port (models module outbound, WORK-005 / INT-002).
 *
 * ENFORCES the frozen "capability before provider" invariant
 * (`spec/architecture.md` §2.5, `IMPLEMENTATION.md` §7 dispatch sequence:
 * … effective policy → budget reservation → CAPABILITY RESOLUTION → plan →
 * dispatch): the model gateway consults this gate BEFORE any rail/provider
 * resolution — an unsatisfied task profile fails canonical
 * `CAPABILITY_UNAVAILABLE` before a route is ever selected.
 *
 * The port input is deliberately RAIL-AGNOSTIC: capability resolution sees
 * the task profile only. Which provider/rail could serve the resolved
 * capabilities is a downstream, separate concern (`spec/architecture.md`
 * §2.5 "Provider/model/agent selection is a downstream implementation
 * choice"). There is deliberately NO default/skip implementation in this
 * module — a gateway cannot be constructed without a capability authority,
 * mirroring the `DispatchAdmission` construction discipline.
 */

import type { CapabilityResolution, TaskCapabilityProfile } from "../../capabilities/public";

/** Resolves a task capability profile against the capability authority. */
export interface TaskCapabilityResolution {
  resolve(profile: TaskCapabilityProfile): Promise<CapabilityResolution>;
}
